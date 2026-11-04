'use strict';

const Homey = require('homey');
const DanfossAllyApi = require('./lib/DanfossAllyApi');

const DEFAULT_POLL_INTERVAL = 45; // seconds
const MIN_POLL_INTERVAL = 10; // seconds
const MAX_POLL_INTERVAL = 300; // seconds
const FALLBACK_RETRY_AFTER = 60; // seconds, when the API does not say

// The bulk /ally/devices list is a stale projection: it lags minutes behind on
// setpoints, mode and availability. It is only reliable for discovery, so it
// runs rarely. Live state comes from /ally/devices/{id} per thermostat.
const BULK_REFRESH_INTERVAL = 600; // seconds
const PER_DEVICE_CONCURRENCY = 5;
// Danfoss throttles on sustained volume, so hold the per-device rate down by
// stretching the refresh when a home has many thermostats.
const MIN_SECONDS_PER_THERMOSTAT = 10;

class DanfossAllyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Danfoss Ally app has been initialized');

    this.api = new DanfossAllyApi();
    this._pollInterval = null;
    this._lastWriteTime = 0;
    this._lastPollTime = 0;
    this._rateLimitedUntil = 0;
    this._lastBulkTime = 0;
    this._bulkTimer = null;

    // Try to initialize with stored credentials
    const apiKey = this.homey.settings.get('api_key');
    const apiSecret = this.homey.settings.get('api_secret');

    if (apiKey && apiSecret) {
      try {
        await this.initializeApi(apiKey, apiSecret);
      } catch (err) {
        this.error('Failed to initialize API with stored credentials:', err.message);
      }
    }

    // Listen for settings changes
    this.homey.settings.on('set', async (key) => {
      if (key === 'api_key' || key === 'api_secret') {
        const newKey = this.homey.settings.get('api_key');
        const newSecret = this.homey.settings.get('api_secret');
        if (newKey && newSecret) {
          try {
            await this.initializeApi(newKey, newSecret);
          } catch (err) {
            this.error('Failed to initialize API after settings change:', err.message);
          }
        }
      } else if (key === 'poll_interval') {
        this._startPolling();
      }
    });

    // Register flow cards
    this._registerFlowCards();
  }

  /**
   * Register flow card handlers
   */
  _registerFlowCards() {
    // Condition: Temperature is above
    const conditionTemperatureAbove = this.homey.flow.getConditionCard('temperature_above');
    conditionTemperatureAbove.registerRunListener(async (args) => {
      const currentTemp = args.device.getCapabilityValue('measure_temperature');
      return currentTemp > args.temperature;
    });

    // Action: Set temperature
    const actionSetTemperature = this.homey.flow.getActionCard('set_temperature');
    actionSetTemperature.registerRunListener(async (args) => {
      // Trigger the capability listener which handles API communication
      await args.device.triggerCapabilityListener('target_temperature', args.temperature);
    });

    // Action: Set mode
    const actionSetMode = this.homey.flow.getActionCard('set_mode');
    actionSetMode.registerRunListener(async (args) => {
      const deviceId = args.device.getData().id;
      await this.setMode(deviceId, args.mode);
    });

    // Action: Set mode for all thermostats
    const actionSetModeAll = this.homey.flow.getActionCard('set_mode_all');
    actionSetModeAll.registerRunListener(async (args) => {
      const devices = this.getAllDevices();
      const results = [];
      for (const [deviceId, deviceData] of Object.entries(devices)) {
        if (deviceData.isThermostat) {
          results.push(this.setMode(deviceId, args.mode));
        }
      }
      await Promise.all(results);
    });

    this.log('Flow cards registered');
  }

  /**
   * Initialize the API client with credentials
   * @param {string} key - API key
   * @param {string} secret - API secret
   */
  async initializeApi(key, secret) {
    this.log('Initializing Danfoss Ally API...');

    await this.api.initialize(key, secret);

    if (this.api.authorized) {
      this.log('API authorized successfully');

      // Fetch initial device list
      await this.pollDevices();

      // Start polling
      this._startPolling();
    } else {
      throw new Error('API authorization failed');
    }
  }

  /**
   * Get the configured poll interval in milliseconds
   * @returns {number}
   */
  _getPollInterval() {
    const setting = this.homey.settings.get('poll_interval');
    const seconds = Math.min(MAX_POLL_INTERVAL, Math.max(MIN_POLL_INTERVAL, setting || DEFAULT_POLL_INTERVAL));
    return seconds * 1000;
  }

  /**
   * Start the polling interval
   */
  _startPolling() {
    this._stopPolling();

    const interval = this._getRefreshInterval();

    this._pollInterval = this.homey.setInterval(async () => {
      await this.refreshThermostats();
    }, interval);

    this._bulkTimer = this.homey.setInterval(async () => {
      await this.pollDevices();
    }, BULK_REFRESH_INTERVAL * 1000);

    this.log(`Refreshing thermostats every ${interval / 1000}s, full device list every ${BULK_REFRESH_INTERVAL}s`);
  }

  /**
   * How often to refresh thermostats, in milliseconds.
   *
   * The configured interval is honoured unless the number of thermostats would
   * push the request rate into Danfoss's throttling, in which case it is
   * stretched. Each thermostat costs one request per refresh.
   * @returns {number}
   */
  _getRefreshInterval() {
    const configured = this._getPollInterval();
    const thermostats = this._getThermostatIds().length;
    const floor = thermostats * MIN_SECONDS_PER_THERMOSTAT * 1000;
    return Math.max(configured, floor);
  }

  /**
   * Ids of every cached device that is a thermostat.
   * @returns {string[]}
   */
  _getThermostatIds() {
    const devices = (this.api && this.api.devices) || {};
    return Object.keys(devices).filter((id) => devices[id] && devices[id].isThermostat);
  }

  /**
   * Refresh live state for every thermostat from its own endpoint.
   *
   * The bulk list cannot be used for this: it is routinely minutes behind on
   * the setpoint and the mode, and since the mode selects which setpoint field
   * to read, a stale mode yields the wrong field rather than merely an old
   * number.
   */
  async refreshThermostats() {
    if (Date.now() < this._rateLimitedUntil) {
      return;
    }

    const ids = this._getThermostatIds();
    if (ids.length === 0) {
      return;
    }

    const timeSinceWrite = Date.now() - this._lastWriteTime;
    if (timeSinceWrite < 1000) {
      await new Promise((resolve) => this.homey.setTimeout(resolve, 1000));
    }

    const queue = [...ids];
    let rateLimited = null;
    let refreshed = 0;

    const worker = async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        try {
          await this.api.getDevice(id);
          refreshed++;
        } catch (err) {
          if (err.code === 'RATE_LIMITED') {
            rateLimited = err;
            queue.length = 0;
            return;
          }
          this.error(`Failed to refresh ${id}:`, err.message);
        }
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(PER_DEVICE_CONCURRENCY, ids.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    if (rateLimited) {
      // Wait exactly as long as the API asked. Any longer is a penalty of our
      // own invention and starves every device of fresh data for no reason.
      const retryAfter = rateLimited.retryAfter > 0 ? rateLimited.retryAfter : FALLBACK_RETRY_AFTER;
      this._rateLimitedUntil = Date.now() + (retryAfter * 1000);
      this.error(`Rate limited while refreshing thermostats. Pausing for ${retryAfter}s.`);
    }

    this._lastPollTime = Date.now();
    this.homey.emit('danfoss_ally_update', this.api.devices);

    if (refreshed > 0) {
      this.log(`Refreshed ${refreshed} thermostat(s)`);
    }
  }

  /**
   * Stop the polling interval
   */
  _stopPolling() {
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    if (this._bulkTimer) {
      this.homey.clearInterval(this._bulkTimer);
      this._bulkTimer = null;
    }
  }

  /**
   * Fetch the full device list.
   *
   * This is discovery: names, models, which devices exist and which are
   * thermostats. Its setpoints and modes are not trustworthy, so drivers get
   * their live values from refreshThermostats instead.
   */
  async pollDevices() {
    // The Danfoss API rejects polls for a while once it has rate limited us.
    // Polling through that window keeps the penalty alive and starves every
    // device of fresh data, so sit it out instead.
    if (Date.now() < this._rateLimitedUntil) {
      return;
    }

    // Postpone poll if a recent write was made (avoid UI glitches)
    const timeSinceWrite = Date.now() - this._lastWriteTime;
    if (timeSinceWrite < 1000) {
      this.log('Postponing poll due to recent write');
      await new Promise((resolve) => this.homey.setTimeout(resolve, 1000));
    }

    try {
      const devices = await this.api.getDeviceList();
      this._lastBulkTime = Date.now();
      this._lastPollTime = Date.now();

      // Emit event for all drivers to update their devices
      this.homey.emit('danfoss_ally_update', devices);

      this.log(`Fetched device list: ${Object.keys(devices).length} devices`);
    } catch (err) {
      if (err.code === 'RATE_LIMITED') {
        const retryAfter = err.retryAfter > 0 ? err.retryAfter : FALLBACK_RETRY_AFTER;
        this._rateLimitedUntil = Date.now() + (retryAfter * 1000);
        this.error(`Rate limited by Danfoss API. Pausing polls for ${retryAfter}s. Consider increasing the poll interval (currently ${this._getPollInterval() / 1000}s).`);
      } else {
        this.error('Failed to poll devices:', err.message);
      }
    }
  }

  /**
   * Set temperature for a device (called by device instances)
   * @param {string} deviceId - Device ID
   * @param {number} temperature - Target temperature
   * @param {string} code - Temperature setpoint code
   */
  async setTemperature(deviceId, temperature, code = 'manual_mode_fast') {
    this._lastWriteTime = Date.now();

    try {
      const success = await this.api.setTemperature(deviceId, temperature, code);
      if (success) {
        this.log(`Set temperature for ${deviceId} to ${temperature} (${code})`);
      }
      return success;
    } catch (err) {
      this.error(`Failed to set temperature for ${deviceId}:`, err.message);
      throw err;
    }
  }

  /**
   * Apply a manual temperature override for a device.
   * @param {string} deviceId - Device ID
   * @param {number} temperature - Temperature in tenths of a degree
   */
  async setManualTemperature(deviceId, temperature) {
    this._lastWriteTime = Date.now();

    try {
      const success = await this.api.setManualTemperature(deviceId, temperature);
      if (success) {
        this.log(`Set ${deviceId} to manual at ${temperature / 10}`);
      }
      return success;
    } catch (err) {
      this.error(`Failed to set manual temperature for ${deviceId}:`, err.message);
      throw err;
    }
  }

  /**
   * Set mode for a device (called by device instances)
   * @param {string} deviceId - Device ID
   * @param {string} mode - Operating mode
   */
  async setMode(deviceId, mode) {
    this._lastWriteTime = Date.now();

    try {
      const success = await this.api.setMode(deviceId, mode);
      if (success) {
        this.log(`Set mode for ${deviceId} to ${mode}`);
      }
      return success;
    } catch (err) {
      this.error(`Failed to set mode for ${deviceId}:`, err.message);
      throw err;
    }
  }

  /**
   * Send commands to a device (called by device instances)
   * @param {string} deviceId - Device ID
   * @param {Array} commands - Array of {code, value} objects
   */
  async sendCommands(deviceId, commands) {
    this._lastWriteTime = Date.now();

    try {
      const success = await this.api.sendCommand(deviceId, commands);
      if (success) {
        this.log(`Sent commands to ${deviceId}:`, commands);
      }
      return success;
    } catch (err) {
      this.error(`Failed to send commands to ${deviceId}:`, err.message);
      throw err;
    }
  }

  /**
   * Get cached device data
   * @param {string} deviceId - Device ID
   * @returns {object|null} - Device data or null
   */
  getDeviceData(deviceId) {
    return this.api.devices[deviceId] || null;
  }

  /**
   * Get all cached devices
   * @returns {object} - All devices
   */
  getAllDevices() {
    return this.api.devices;
  }

  /**
   * Check if API is authorized
   * @returns {boolean}
   */
  isAuthorized() {
    return this.api && this.api.authorized;
  }

  /**
   * Called when app is unloaded
   */
  async onUninit() {
    this._stopPolling();
  }

}

module.exports = DanfossAllyApp;

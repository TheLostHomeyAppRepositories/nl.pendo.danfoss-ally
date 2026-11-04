'use strict';

const BASE_URL = 'https://api.danfoss.com';
const TOKEN_ENDPOINT = '/oauth2/token';
const DEVICES_ENDPOINT = '/ally/devices';
const DEFAULT_RETRY_AFTER = 60;

// Mode → setpoint code mapping. Used to drive the new mode's setpoint into
// manual_mode_fast after a mode change, which is what actually moves the valve.
const MODE_SETPOINT_MAP = {
  at_home: 'at_home_setting',
  leaving_home: 'leaving_home_setting',
  manual: 'manual_mode_fast',
  pause: 'pause_setting',
  holiday: 'holiday_setting',
  holiday_sat: 'at_home_setting',
};

// Mode → `last_click_time` suffix. The Danfoss cloud accepts a bare mode change
// and reports it back, but the gateway only pushes the change down to the valves
// when the mode command carries this stamp. Only these two modes need it. The
// format was reverse engineered by pydanfossally from the Danfoss Ally app.
const MODE_LAST_CLICK_SUFFIX = {
  at_home: '010000',
  leaving_home: '000101',
};

/**
 * Format a date as the YYYYMMDDHHMM prefix of a `last_click_time` value.
 * @param {Date} date - Date to format, in local time
 * @returns {string}
 */
function formatLastClickTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * Danfoss Ally API client
 * Ported from pydanfossally Python library
 */
class DanfossAllyApi {

  constructor() {
    this._key = null;
    this._secret = null;
    this._token = null;
    this._tokenExpires = null;
    this._authorized = false;
    this._devices = {};
  }

  /**
   * Initialize and authorize with the Danfoss Ally API
   * @param {string} key - API key from developer.danfoss.com
   * @param {string} secret - API secret from developer.danfoss.com
   * @returns {Promise<boolean>} - Authorization success
   */
  async initialize(key, secret) {
    this._key = key;
    this._secret = secret;

    try {
      await this._getToken();
      this._authorized = true;
      return true;
    } catch (err) {
      this._authorized = false;
      throw err;
    }
  }

  /**
   * Get OAuth2 access token using client credentials flow
   */
  async _getToken() {
    const credentials = Buffer.from(`${this._key}:${this._secret}`).toString('base64');

    const response = await fetch(`${BASE_URL}${TOKEN_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Authentication failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    this._token = data.access_token;
    // Set expiration 30 seconds before actual expiry for safety margin
    this._tokenExpires = Date.now() + (data.expires_in - 30) * 1000;

    return this._token;
  }

  /**
   * Ensure we have a valid token, refresh if needed
   */
  async _ensureToken() {
    if (!this._token || Date.now() >= this._tokenExpires) {
      await this._getToken();
    }
  }

  /**
   * Make an authenticated API request
   * @param {string} endpoint - API endpoint
   * @param {string} method - HTTP method
   * @param {object} body - Request body (optional)
   * @returns {Promise<object>} - Response data
   */
  async _request(endpoint, method = 'GET', body = null) {
    await this._ensureToken();

    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${this._token}`,
        'Accept': 'application/json',
      },
    };

    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${BASE_URL}${endpoint}`, options);

    if (response.status === 401) {
      // Token expired, try to refresh once
      await this._getToken();
      options.headers['Authorization'] = `Bearer ${this._token}`;
      const retryResponse = await fetch(`${BASE_URL}${endpoint}`, options);
      if (!retryResponse.ok) {
        throw new Error(`API request failed: ${retryResponse.status}`);
      }
      return retryResponse.json();
    }

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('Retry-After'), 10) || DEFAULT_RETRY_AFTER;
      const err = new Error(`Rate limited by Danfoss API, retry after ${retryAfter}s`);
      err.code = 'RATE_LIMITED';
      err.retryAfter = retryAfter;
      throw err;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  /**
   * Get list of all devices and process their data
   * @returns {Promise<object>} - Devices object keyed by device ID
   */
  async getDeviceList() {
    const data = await this._request(DEVICES_ENDPOINT);

    if (data && data.result) {
      this._devices = {};
      for (const device of data.result) {
        this._handleDeviceData(device);
      }
    }

    return this._devices;
  }

  /**
   * Process device data and extract relevant properties
   * @param {object} device - Raw device data from API
   */
  _handleDeviceData(device) {
    const deviceId = device.id;
    const deviceData = {
      id: deviceId,
      name: device.name || 'Unknown Device',
      model: device.model || device.device_type || 'Unknown',
      online: device.online || false,
      isThermostat: false,
    };

    // Process status array into key-value pairs
    if (device.status && Array.isArray(device.status)) {
      for (const status of device.status) {
        const code = status.code;
        let value = status.value;

        // Convert boolean strings
        if (value === 'true') value = true;
        if (value === 'false') value = false;

        deviceData[code] = value;
      }
    }

    // The API reports floor temperature as MeasuredValue alongside a
    // floor_sensor flag, never as a floor_temperature code. Derive it in
    // degrees so drivers can read it directly, and leave an explicit
    // floor_temperature alone if one ever appears.
    if (
      !('floor_temperature' in deviceData)
      && deviceData.floor_sensor
      && typeof deviceData.MeasuredValue === 'number'
    ) {
      deviceData.floor_temperature = deviceData.MeasuredValue / 10;
    }

    // Determine if device is a thermostat
    deviceData.isThermostat = this._isThermostat(deviceData);

    this._devices[deviceId] = deviceData;
  }

  /**
   * Check if device is a thermostat based on its capabilities
   * Based on pydanfossally: device is thermostat if it has setpoint codes
   * @param {object} deviceData - Processed device data
   * @returns {boolean}
   */
  _isThermostat(deviceData) {
    // Device is a thermostat if it has ANY temperature setpoint control
    // This matches pydanfossally's detection logic exactly
    return (
      'manual_mode_fast' in deviceData ||
      'at_home_setting' in deviceData ||
      'leaving_home_setting' in deviceData ||
      'pause_setting' in deviceData ||
      'holiday_setting' in deviceData ||
      'temp_set' in deviceData
    );
  }

  /**
   * Get a specific device
   * @param {string} deviceId - Device ID
   * @returns {Promise<object>} - Device data
   */
  async getDevice(deviceId) {
    const data = await this._request(`${DEVICES_ENDPOINT}/${deviceId}`);
    if (data && data.result) {
      this._handleDeviceData(data.result);
      return this._devices[deviceId];
    }
    return null;
  }

  /**
   * Set temperature for a device
   * @param {string} deviceId - Device ID
   * @param {number} temperature - Target temperature
   * @param {string} code - Temperature code (e.g., 'manual_mode_fast', 'at_home_setting')
   * @returns {Promise<boolean>} - Success
   */
  async setTemperature(deviceId, temperature, code = 'manual_mode_fast') {
    const commands = [{ code, value: temperature }];
    return this.sendCommand(deviceId, commands);
  }

  /**
   * Set operating mode for a device
   * @param {string} deviceId - Device ID
   * @param {string} mode - Mode (e.g., 'at_home', 'leaving_home', 'manual', 'pause')
   * @returns {Promise<boolean>} - Success
   */
  async setMode(deviceId, mode) {
    const commands = [{ code: 'mode', value: mode }];

    const clickSuffix = MODE_LAST_CLICK_SUFFIX[mode];
    if (clickSuffix) {
      commands.push({
        code: 'last_click_time',
        value: `${formatLastClickTime(new Date())}${clickSuffix}`,
      });
    }

    const modeWritten = await this.sendCommand(deviceId, commands);
    if (!modeWritten) {
      return false;
    }

    // Then drive the valve. The mode's own setpoint code is configuration: the
    // controller only acts on manual_mode_fast, so write the new mode's
    // setpoint value into that register as a second request.
    const setpointCode = MODE_SETPOINT_MAP[mode];
    const cached = this._devices[deviceId];
    if (
      setpointCode
      && cached
      && typeof cached[setpointCode] === 'number'
      && typeof cached.manual_mode_fast === 'number'
    ) {
      await this.sendCommand(deviceId, [
        { code: 'manual_mode_fast', value: cached[setpointCode] },
      ]);
    }

    return true;
  }

  /**
   * Send commands to a device
   * @param {string} deviceId - Device ID
   * @param {Array} commands - Array of {code, value} objects
   * @returns {Promise<boolean>} - Success
   */
  async sendCommand(deviceId, commands) {
    const body = { commands };
    const data = await this._request(`${DEVICES_ENDPOINT}/${deviceId}/commands`, 'POST', body);
    return data && data.result === true;
  }

  /**
   * Get all cached devices
   * @returns {object} - Devices object
   */
  get devices() {
    return this._devices;
  }

  /**
   * Check if authorized
   * @returns {boolean}
   */
  get authorized() {
    return this._authorized;
  }

}

module.exports = DanfossAllyApi;

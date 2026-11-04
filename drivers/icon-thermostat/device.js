'use strict';

const Homey = require('homey');

// Mode mapping: Danfoss mode -> setpoint code
const MODE_SETPOINT_MAP = {
  at_home: 'at_home_setting',
  leaving_home: 'leaving_home_setting',
  manual: 'manual_mode_fast',
  pause: 'pause_setting',
  holiday: 'holiday_setting',
  holiday_sat: 'at_home_setting',
};

// Modes the mode picker offers, matching .homeycompose/capabilities/danfoss_mode.json
const SELECTABLE_MODES = ['at_home', 'leaving_home', 'holiday', 'holiday_sat', 'pause', 'manual'];

class IconThermostatDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Icon Thermostat device has been initialized');

    // Get device ID from data
    this._deviceId = this.getData().id;
    this._fallbackToTempSet = false;

    await this._migrateModeCapability();

    // Register capability listeners
    this.registerCapabilityListener('target_temperature', async (value) => {
      await this._setTargetTemperature(value);
    });

    this.registerCapabilityListener('danfoss_mode', async (value) => {
      await this.homey.app.setMode(this._deviceId, value);
    });

    // Listen for updates from the app
    this.homey.on('danfoss_ally_update', (devices) => {
      this._onDeviceUpdate(devices);
    });

    // Initial sync
    this._syncFromApi();
  }

  /**
   * Recreate the mode capability on devices that predate the picker.
   *
   * Homey copies a capability's definition onto the device when it is added,
   * so a device that gained this one while it was a read-only text row keeps
   * that definition and a label as its value. The picker cannot match either,
   * so remove and re-add it once to pick up the current definition.
   */
  async _migrateModeCapability() {
    if (!this.hasCapability('danfoss_mode')) {
      return;
    }
    if (this.getStoreValue('mode_capability_rev')) {
      return;
    }

    try {
      await this.removeCapability('danfoss_mode');
      await this.addCapability('danfoss_mode');
      await this.setStoreValue('mode_capability_rev', true);
      this.log('Recreated the mode capability as a picker');
    } catch (err) {
      this.error('Failed to migrate the mode capability:', err.message);
    }
  }

  /**
   * Called when device data is updated from API
   */
  _onDeviceUpdate(devices) {
    const deviceData = devices[this._deviceId];
    if (deviceData) {
      this._updateCapabilities(deviceData);
    }
  }

  /**
   * Sync device state from API
   */
  _syncFromApi() {
    const app = this.homey.app;
    const deviceData = app.getDeviceData(this._deviceId);

    if (deviceData) {
      this._updateCapabilities(deviceData);
    }
  }

  /**
   * Update capabilities from device data
   */
  async _updateCapabilities(deviceData) {
    // Availability and values are independent. A payload flagged offline
    // still carries valid setpoints, and the flag itself comes from a
    // source that lags, so discarding the data freezes the tile on stale
    // values for a device that is usually working.
    if (deviceData.online === false) {
      this.setUnavailable('Device is offline').catch(this.error);
    } else {
      this.setAvailable().catch(this.error);
    }

    await this._syncTemperatureRange(deviceData);

    // Determine if we need to use fallback temp_set
    this._fallbackToTempSet = !(
      'manual_mode_fast' in deviceData
      && 'at_home_setting' in deviceData
      && 'leaving_home_setting' in deviceData
      && 'pause_setting' in deviceData
    ) && 'temp_set' in deviceData;

    // Update measure_temperature (current room temperature)
    if ('temperature' in deviceData) {
      this.setCapabilityValue('measure_temperature', deviceData.temperature).catch(this.error);
    } else if ('temp_current' in deviceData) {
      this.setCapabilityValue('measure_temperature', deviceData.temp_current / 10).catch(this.error);
    }

    // Update floor temperature if available
    if ('floor_temperature' in deviceData && this.hasCapability('measure_temperature.floor')) {
      this.setCapabilityValue('measure_temperature.floor', deviceData.floor_temperature).catch(this.error);
    }

    // Update target_temperature
    const targetTemp = this._getSetpointForCurrentMode(deviceData);
    if (targetTemp !== null) {
      // All Ally API setpoint codes are reported in tenths of a degree
      const temp = targetTemp / 10;
      this.setCapabilityValue('target_temperature', temp).catch(this.error);
    }

    // Update measure_humidity if available
    if ('humidity' in deviceData) {
      if (!this.hasCapability('measure_humidity')) {
        await this.addCapability('measure_humidity').catch(this.error);
      }
      this.setCapabilityValue('measure_humidity', deviceData.humidity).catch(this.error);
    } else if ('humidity_value' in deviceData) {
      if (!this.hasCapability('measure_humidity')) {
        await this.addCapability('measure_humidity').catch(this.error);
      }
      const humidity = deviceData.humidity_value / 10;
      this.setCapabilityValue('measure_humidity', humidity).catch(this.error);
    }

    // Surface the mode the gateway reports, so it is visible in Homey rather
    // than only in the logs.
    if (!this.hasCapability('danfoss_mode')) {
      await this.addCapability('danfoss_mode').catch(this.error);
    }
    // Only the modes the picker defines may be written: an enum rejects
    // anything else. An unrecognised mode keeps the previous value.
    if (SELECTABLE_MODES.includes(deviceData.mode)) {
      this.setCapabilityValue('danfoss_mode', deviceData.mode).catch(this.error);
    } else if ('mode' in deviceData) {
      this.log(`Ignoring unknown mode from the API: ${deviceData.mode}`);
    }

    // Update battery if available
    if ('battery' in deviceData) {
      this.setCapabilityValue('measure_battery', deviceData.battery).catch(this.error);
    } else if ('battery_percentage' in deviceData) {
      this.setCapabilityValue('measure_battery', deviceData.battery_percentage).catch(this.error);
    }

    this.log(`Updated Icon Thermostat ${this._deviceId}: temp=${deviceData.temp_current / 10}, floor_temp=${deviceData.floor_temperature}, target=${targetTemp} [mode=${deviceData.mode}, temp_set=${deviceData.temp_set}, manual_mode_fast=${deviceData.manual_mode_fast}, at_home_setting=${deviceData.at_home_setting}, holiday_setting=${deviceData.holiday_setting}, work_state=${deviceData.work_state}, SetpointChangeSource=${deviceData.SetpointChangeSource ?? deviceData.setpointchangesource}]`);
  }

  /**
   * Mirror the device's own temperature limits onto the capability.
   *
   * The range is configured per room in the Ally app, so one hardcoded range
   * is wrong for most systems: Homey would offer values the device refuses,
   * and the tile would snap back as though we had lost the write. Writing
   * capability options is expensive, so only write when a limit changed.
   * @param {object} deviceData - Device data from the API
   */
  async _syncTemperatureRange(deviceData) {
    const hasLower = typeof deviceData.lower_temp === 'number';
    const hasUpper = typeof deviceData.upper_temp === 'number';
    if (!hasLower && !hasUpper) {
      return;
    }

    let current;
    try {
      current = this.getCapabilityOptions('target_temperature') || {};
    } catch (err) {
      return;
    }

    const next = { ...current };
    if (hasLower) {
      next.min = deviceData.lower_temp / 10;
    }
    if (hasUpper) {
      next.max = deviceData.upper_temp / 10;
    }

    if (next.min === current.min && next.max === current.max) {
      return;
    }

    try {
      await this.setCapabilityOptions('target_temperature', next);
      this.log(`Temperature range now ${next.min}-${next.max}`);
    } catch (err) {
      this.error('Failed to set temperature range:', err.message);
    }
  }

  /**
   * Get the active setpoint.
   *
   * The room runs the setpoint belonging to the mode it is in, so vacation
   * reads holiday_setting and pause reads pause_setting. temp_set is not
   * mode-aware on Icon: it tracks the at-home value and stays put when the
   * mode changes, so it must not be used as the setpoint for every mode.
   */
  _getSetpointForCurrentMode(deviceData) {
    const setpointCode = this._resolveSetpointCode(deviceData);

    if (setpointCode in deviceData) {
      return deviceData[setpointCode];
    }

    // The code for this mode is not reported at all, so fall back to the
    // single setpoint. This has to stay demand-driven: a room can omit
    // manual_mode_fast while still reporting every mode preset, and those
    // presets remain authoritative.
    if ('temp_set' in deviceData) {
      return deviceData.temp_set;
    }

    if ('manual_mode_fast' in deviceData) {
      return deviceData.manual_mode_fast;
    }

    return null;
  }

  /**
   * Resolve which setpoint code currently holds the active setpoint.
   */
  _resolveSetpointCode(deviceData) {
    if (this._isManualOverride(deviceData)) {
      return 'manual_mode_fast';
    }

    return 'mode' in deviceData
      ? this._getSetpointCode(deviceData.mode)
      : 'manual_mode_fast';
  }

  /**
   * Whether the setpoint was last changed at the thermostat itself.
   *
   * A manual change there wins over the mode preset: the device runs that
   * value even while the gateway still reports a house mode. Danfoss is
   * inconsistent about both the key's capitalisation and the value's, so
   * compare case-insensitively.
   * @param {object} deviceData - Device data from the API
   * @returns {boolean}
   */
  _isManualOverride(deviceData) {
    const source = deviceData.SetpointChangeSource ?? deviceData.setpointchangesource;
    return typeof source === 'string' && source.toLowerCase() === 'manual';
  }

  /**
   * Get the setpoint code for a mode
   */
  _getSetpointCode(mode) {
    return MODE_SETPOINT_MAP[mode] || 'manual_mode_fast';
  }

  /**
   * Set target temperature
   */
  async _setTargetTemperature(temperature) {
    const app = this.homey.app;
    const deviceData = app.getDeviceData(this._deviceId);

    let setpointCode = 'manual_mode_fast';

    if (this._fallbackToTempSet) {
      setpointCode = 'temp_set';
    } else if (deviceData && 'mode' in deviceData) {
      setpointCode = this._getSetpointCode(deviceData.mode);
    }

    // Icon devices may need temperature in tenths or direct value - try tenths first
    const tempInTenths = Math.round(temperature * 10);

    try {
      await app.setTemperature(this._deviceId, tempInTenths, setpointCode);
      this.log(`Set temperature to ${temperature}°C (${tempInTenths} tenths, ${setpointCode})`);
    } catch (err) {
      this.error('Failed to set temperature:', err.message);
      throw err;
    }
  }

  /**
   * Called when device is added
   */
  async onAdded() {
    this.log('Icon Thermostat device has been added');
  }

  /**
   * Called when device settings are changed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);
  }

  /**
   * Called when device is renamed
   */
  async onRenamed(name) {
    this.log('Device was renamed to:', name);
  }

  /**
   * Called when device is deleted
   */
  async onDeleted() {
    this.log('Icon Thermostat device has been deleted');
  }

}

module.exports = IconThermostatDevice;

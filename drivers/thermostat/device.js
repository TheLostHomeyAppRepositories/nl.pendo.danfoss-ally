'use strict';

const Homey = require('homey');
const DanfossAllyApi = require('../../lib/DanfossAllyApi');

// Mode mapping: Danfoss mode -> setpoint code
const MODE_SETPOINT_MAP = {
  at_home: 'at_home_setting',
  leaving_home: 'leaving_home_setting',
  manual: 'manual_mode_fast',
  pause: 'pause_setting',
  holiday: 'holiday_setting',
  holiday_sat: 'at_home_setting',
};

class ThermostatDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Thermostat device has been initialized');

    // Get device ID from data
    this._deviceId = this.getData().id;
    this._fallbackToTempSet = false;

    // Register capability listeners
    this.registerCapabilityListener('target_temperature', async (value) => {
      await this._setTargetTemperature(value);
    });

    // Listen for updates from the app
    this.homey.on('danfoss_ally_update', (devices) => {
      this._onDeviceUpdate(devices);
    });

    // Initial sync
    this._syncFromApi();
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
    // Check if device is online
    if (deviceData.online === false) {
      this.setUnavailable('Device is offline').catch(this.error);
      return;
    }

    this.setAvailable().catch(this.error);

    // Determine if we need to use fallback temp_set
    this._fallbackToTempSet = !(
      'manual_mode_fast' in deviceData &&
      'at_home_setting' in deviceData &&
      'leaving_home_setting' in deviceData &&
      'pause_setting' in deviceData
    ) && 'temp_set' in deviceData;

    // Update measure_temperature (temp_current is in tenths of degrees)
    if ('temp_current' in deviceData) {
      let currentTemp = deviceData.temp_current / 10;

      // Use external sensor temperature if radiator is covered
      if (deviceData.radiator_covered && 'ext_measured_rs' in deviceData && deviceData.ext_measured_rs > 0) {
        currentTemp = deviceData.ext_measured_rs / 100; // ext_measured_rs is in hundredths
      }

      this.setCapabilityValue('measure_temperature', currentTemp).catch(this.error);
    }

    // Update target_temperature (setpoints are in tenths of degrees)
    const targetTempRaw = this._getSetpointForCurrentMode(deviceData);
    if (targetTempRaw !== null) {
      const targetTemp = targetTempRaw / 10;
      this.setCapabilityValue('target_temperature', targetTemp).catch(this.error);
    }

    // Update measure_humidity if available (humidity_value is in tenths of percent)
    if ('humidity_value' in deviceData) {
      if (!this.hasCapability('measure_humidity')) {
        await this.addCapability('measure_humidity').catch(this.error);
      }
      const humidity = deviceData.humidity_value / 10;
      this.setCapabilityValue('measure_humidity', humidity).catch(this.error);
    } else if ('humidity' in deviceData) {
      if (!this.hasCapability('measure_humidity')) {
        await this.addCapability('measure_humidity').catch(this.error);
      }
      this.setCapabilityValue('measure_humidity', deviceData.humidity).catch(this.error);
    }

    // Surface the mode the gateway reports, so it is visible in Homey rather
    // than only in the logs.
    if (!this.hasCapability('danfoss_mode')) {
      await this.addCapability('danfoss_mode').catch(this.error);
    }
    this.setCapabilityValue('danfoss_mode', DanfossAllyApi.formatMode(deviceData.mode)).catch(this.error);

    // Update measure_battery
    if ('battery_percentage' in deviceData) {
      this.setCapabilityValue('measure_battery', deviceData.battery_percentage).catch(this.error);
    }

    this.log(`Updated device ${this._deviceId}: temp=${deviceData.temp_current / 10}°C, target=${targetTempRaw / 10}°C, battery=${deviceData.battery_percentage}%`);
  }

  /**
   * Get the setpoint value for the current mode
   */
  _getSetpointForCurrentMode(deviceData) {
    if (this._fallbackToTempSet && 'temp_set' in deviceData) {
      return deviceData.temp_set;
    }

    if ('mode' in deviceData) {
      const setpointCode = this._getSetpointCode(deviceData.mode);
      if (setpointCode && setpointCode in deviceData) {
        return deviceData[setpointCode];
      }
    }

    return null;
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

    // Convert to tenths for the API
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
    this.log('Thermostat device has been added');
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
    this.log('Thermostat device has been deleted');
  }

}

module.exports = ThermostatDevice;

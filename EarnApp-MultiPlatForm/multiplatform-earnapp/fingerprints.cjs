'use strict';
const PLATFORM_FINGERPRINTS = {
  "linux": {
    "prefix": "sdk-node-",
    "appid": "node_earnapp.com",
    "os_name": "Ubuntu 22.04.3 LTS",
    "release": "ubuntu_22.04_x64",
    "arch": "x64",
    "hostname_prefix": "node-worker",
    "ifname": "wlan0"
  },
  "mac": {
    "prefix": "sdk-mac-",
    "appid": "mac_com.earnapp",
    "os_name": "macOS 14.2.1",
    "release": "darwin_23.2.0_arm64",
    "arch": "arm64",
    "hostname_prefix": "macbook-pro",
    "ifname": "en0"
  },
  "win": {
    "prefix": "sdk-win-",
    "appid": "win_earnapp.com",
    "os_name": "Windows 10 Pro",
    "release": "win32_10.0.19045",
    "arch": "x64",
    "hostname_prefix": "desktop-pc",
    "ifname": "Ethernet"
  },
  "ios": {
    "prefix": "sdk-ios-",
    "appid": "ios_com.brd.earnapp",
    "os_name": "iOS 17.2.1",
    "release": "ios_17.2.1_arm64",
    "arch": "arm64",
    "hostname_prefix": "iphone",
    "ifname": "en0"
  }
};
module.exports = {PLATFORM_FINGERPRINTS};

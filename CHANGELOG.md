# Changelog

## [1.1.0](https://github.com/tbaur/keystone/compare/v1.0.4...v1.1.0) (2026-11-27)


### Features

* add allowedHosts to refuse other host names (DNS rebinding) ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* filter the log to lines from Homebridge itself ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))


### Bug Fixes

* answer a malformed request with 400, not a server error ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* drop a page of older lines that finishes after the log starts over ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* keep a page that stays open signed in past 30 days ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* keep line ids counting up after retention removes every line ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* keep the page working with a stale bookmark or a failed load ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* keep your place in the log when you turn wrapping on or off ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* let the service manager retry a database it cannot open ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* lock unknown user names like real ones and trust known addresses ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* log a lost log stream once and show how long it is down ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* read log times from every locale, calendar and clock change ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* say a config or secrets file is missing or unreadable ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* show a banner while new log lines cannot be saved ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* stop "Loading older lines…" staying on screen after the log reloads ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* stop a search or a prune from holding up the server ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* stop the log jumping a few lines after older lines load ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))
* warn about plain http to a host whose name starts with 127. ([57bd48c](https://github.com/tbaur/keystone/commit/57bd48c939430a594f10726a38f236d07db80440))

## [1.0.4](https://github.com/tbaur/keystone/compare/v1.0.3...v1.0.4) (2026-11-27)


### Bug Fixes

* keep the log in place when older lines load as you scroll up ([9a9a284](https://github.com/tbaur/keystone/commit/9a9a28453e43069018230b5e5d698cdcfc5ba73d))

## [1.0.3](https://github.com/tbaur/keystone/compare/v1.0.2...v1.0.3) (2026-11-27)


### Bug Fixes

* stop the log jumping back to the newest line while you scroll up ([7b9548f](https://github.com/tbaur/keystone/commit/7b9548ff76546156e67dd324394471cffd1481b3))

## [1.0.2](https://github.com/tbaur/keystone/compare/v1.0.1...v1.0.2) (2026-11-07)


### Bug Fixes

* give the header a background on small screens so the page no longer shows through it ([#21](https://github.com/tbaur/keystone/issues/21)) ([1869844](https://github.com/tbaur/keystone/commit/186984419ea17ab4332767ed8bec5fa724404fe7))

## [1.0.1](https://github.com/tbaur/keystone/compare/v1.0.0...v1.0.1) (2026-10-23)


### Bug Fixes

* keep the log in place when older lines load ([647375d](https://github.com/tbaur/keystone/commit/647375d2fbcd615fae3458d2e76d75270e6d877d))
* let go of the live log on any scroll up ([#17](https://github.com/tbaur/keystone/issues/17)) ([647375d](https://github.com/tbaur/keystone/commit/647375d2fbcd615fae3458d2e76d75270e6d877d))
* show the message when older log lines fail to load ([647375d](https://github.com/tbaur/keystone/commit/647375d2fbcd615fae3458d2e76d75270e6d877d))

## [1.0.0](https://github.com/tbaur/keystone/compare/v0.2.3...v1.0.0) (2026-10-22)


### Documentation

* update the security policy and release table for 1.0 ([#15](https://github.com/tbaur/keystone/issues/15)) ([9b2843e](https://github.com/tbaur/keystone/commit/9b2843e69e7dd46ea57cadec337ef564663871e2))

## [0.2.3](https://github.com/tbaur/keystone/compare/v0.2.2...v0.2.3) (2026-10-22)


### Bug Fixes

* stay up when a request or a live update fails ([#11](https://github.com/tbaur/keystone/issues/11)) ([8817105](https://github.com/tbaur/keystone/commit/88171051daaac8a35bac8c77f49d4a94003251cf))

## [0.2.2](https://github.com/tbaur/keystone/compare/v0.2.1...v0.2.2) (2026-10-21)


### Bug Fixes

* **web:** leave room between the password field and Sign in ([f27eab6](https://github.com/tbaur/keystone/commit/f27eab634391b6078cc298c028f89a077642d55b))

## [0.2.1](https://github.com/tbaur/keystone/compare/v0.2.0...v0.2.1) (2026-10-21)


### Bug Fixes

* **web:** inset the card's counts and versions, and left-align the footer ([#7](https://github.com/tbaur/keystone/issues/7)) ([22c6024](https://github.com/tbaur/keystone/commit/22c6024d32c6e650dc2acbbc3ed512b7c40e6b96))

## [0.2.0](https://github.com/tbaur/keystone/compare/v0.1.0...v0.2.0) (2026-10-21)


### Features

* **web:** show Homebridge and plugin versions, and a Keystone footer ([#5](https://github.com/tbaur/keystone/issues/5)) ([5dd31ff](https://github.com/tbaur/keystone/commit/5dd31ff73a066d8cb3a44e6fb13b8cab56657b99))

## 0.1.0 (2026-10-21)


### Features

* /healthz for uptime monitors, with instance details only for a signed-in user ([7a896fd](https://github.com/tbaur/keystone/commit/7a896fd5a384e50655a10676830a8dc62f2e88b6))
* a status card per instance with child bridges, errors and warnings per plugin, updates and low batteries, linking into that instance's Homebridge UI and keeping the last known data when it stops answering ([7a896fd](https://github.com/tbaur/keystone/commit/7a896fd5a384e50655a10676830a8dc62f2e88b6))
* filters by instance, level, plugin and text with an indexed text search, kept in the URL ([7a896fd](https://github.com/tbaur/keystone/commit/7a896fd5a384e50655a10676830a8dc62f2e88b6))
* host CPU, memory, network throughput in Mbps and uptime in the top bar, for the instance picked there ([7a896fd](https://github.com/tbaur/keystone/commit/7a896fd5a384e50655a10676830a8dc62f2e88b6))
* Keystone for Homebridge ([7a896fd](https://github.com/tbaur/keystone/commit/7a896fd5a384e50655a10676830a8dc62f2e88b6))
* one live log for every instance, stored in SQLite for retentionDays, with lines replayed after a reconnect dropped and log times read in each host's time zone ([7a896fd](https://github.com/tbaur/keystone/commit/7a896fd5a384e50655a10676830a8dc62f2e88b6))
* settings in config.json and passwords in secrets.json, which npm run secrets writes with mode 600 ([7a896fd](https://github.com/tbaur/keystone/commit/7a896fd5a384e50655a10676830a8dc62f2e88b6))
* sign-in per user with scrypt hashing, sessions with a maximum age, and login throttling per address and per user ([7a896fd](https://github.com/tbaur/keystone/commit/7a896fd5a384e50655a10676830a8dc62f2e88b6))

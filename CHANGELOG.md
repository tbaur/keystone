# Changelog

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

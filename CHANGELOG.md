# Changelog

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

## Changelog

This project follows [Semantic Versioning](https://semver.org). [release-please](RELEASING.md) writes this file from the commit messages, so do not edit it by hand.

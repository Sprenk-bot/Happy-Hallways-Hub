# Hub Host development prototype

This separate Bun process is an early Stage 2 prototype. It stores one versioned Happy Hallways account snapshot in SQLite and uses revision checks to reject stale writes. Its local database survives a browser or host-process restart.

Run it with `bun run hub:host`. It binds only to `127.0.0.1` and writes to `.hub-data/hub.sqlite` by default. Set `HUB_DATABASE_PATH` to choose a different local file. The directory is ignored by Git.

This prototype has no staff sign-in, MFA, LAN access, remote backup, or production audit attribution. It is for fictional development data only. Do not load a real account or expose the service on a network. LAN binding must remain disabled until authenticated TLS and the approved staff identity route are implemented and tested on the intended host and school network.

The API uses the current account as an opaque snapshot only. It does not import, migrate, read, or write the browser's `hallway.account.v2` value. There is no automatic retention or deletion policy. The API is:

- `GET /api/v1/health`
- `GET /api/v1/state`
- `PUT /api/v1/state` with `{ "expectedRevision": number, "snapshot": object }`

Every accepted write is committed with SQLite's full synchronous setting and returned with a revision and SHA-256 checksum. A stale revision receives `409` and the current revision. A damaged snapshot receives an integrity error and is never overwritten.

Run the local service tests with `bun run test:hub-host`.

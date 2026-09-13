# Edge worker — matched SDK 1.651.510

Standalone local Docker build using `sdk-node-1.651.510(1).zip` and your earlier
readable `client.js` and `sdk_conf.js`. The application does not pull or copy
`meowzsitink/edge-worker`; its wrapper was inspected directly as the reference.

## Upgrade from the earlier package

1. Stop the old container with `docker compose down`.
2. Replace the project files, including `config.json` and `spoof_config.json`,
   with this package. **Keep your existing `data` directory.**
3. Start Docker in Linux containers mode.
4. Select a profile and rebuild. For iOS in PowerShell:

```powershell
$env:EARNAPP_CLIENT = 'ios'
docker compose build
docker compose up -d --force-recreate
docker compose logs -f --tail=100 worker
```

All local SDK version fields now read **1.651.510**. If you still see the old
1.665.73 mismatch, the old project/image is still being used.

The matching `.env` setting can be used instead of a PowerShell variable:

```dotenv
EARNAPP_CLIENT=ios
EARNAPP_VERSION_MODE=reference
```

PowerShell variables override `.env`. To stop overriding it:

```powershell
Remove-Item Env:EARNAPP_CLIENT
```

## Profiles and SDK identity

Your requested `PLATFORM_FINGERPRINTS` is defined in `fingerprints.cjs`.
Profiles select it using a `fingerprint` key in `spoof_config.json`.

| Profile | UUID prefix | App ID | Reported OS |
| --- | --- | --- | --- |
| linux | sdk-node- | node_earnapp.com | Ubuntu 22.04.3 LTS |
| mac (alias macos) | sdk-mac- | mac_com.earnapp | macOS 14.2.1 |
| win (alias windows) | sdk-win- | win_earnapp.com | Windows 10 Pro |
| ios | sdk-ios- | ios_com.brd.earnapp | iOS 17.2.1 |

Release, architecture and interface names use your exact values. Hostnames use
`hostname_prefix` plus the last eight UUID digits, stable across restarts.
Explicit `spoof` fields can override device metadata. Fingerprint app IDs are
passed unchanged to registration and into SDK configuration. Tizen, webOS and
the default Node profile remain available. These custom fingerprints differ
from the earlier reference fixtures; live backend acceptance is unverified.

Select a `clients[]` entry in `spoof_config.json` with `EARNAPP_CLIENT`. Empty or
unknown selections fall back to the first entry, matching the reference; an
unknown name prints a warning. The default first entry is Tizen.

Preview without registration:

```sh
docker compose run --rm --no-deps worker profile
```

After changing `.env` or `spoof_config.json`:

```sh
docker compose up -d --force-recreate
```

Your profile's `spoof.arch`, `release`, `ifname` and `iftype` feed the SDK
handshake; `os_name` and `arch` feed registration. `hostname` sets the SDK's
`CONFIG_HOSTNAME` environment setting, as in the reference. The container
itself continues to run Linux.

Optional `trackingId`, `serial`, `uuid` and SOCKS `proxy` settings are supported.
A missing tracking ID and serial are generated once and persisted. Proxy may
be an object `{ "host": "...", "port": 1080, "username": "...", "password": "..." }`
or a SOCKS URL. Registration and the primary SDK websocket use that SOCKS
agent. The reference does not necessarily route every SDK auxiliary request
through this proxy; this project makes no whole-container proxy guarantee.

## Corrected reference behavior

- Every SDK helper, configuration and package version comes from 1.651.510.
- `sdk_conf.js` is exactly the earlier readable upload. Its exports were
  compared with the matching obfuscated configuration and are identical.
- The earlier readable `client.js` remains active, with documented wrapper
  compatibility patches. Original readable and matching vendor files are in
  `reference/`; those archival files are excluded from the Docker image.
- `appid` follows the selected fingerprint in both registration and SDK configuration.
  `partnerid` is `luminati`. The earlier build used the wrong SDK application
  ID, which changed its encoded handshake application identifier.
- Hostname, tracking ID and reported device metadata are passed into SDK config.
- The reference's generic interface polling path is used for these container
  profiles, including webOS; it does not need a native TV service to initialize.
- Registration accepts the reference's truthy `ok` / `preinstall` response fields.
  Failures and timeouts do not create successful-registration markers.
- The reference's reported-version lookup reads `VERSION` from
  `https://brightdata.com/static/earnapp/install.sh`, with an 8-second request
  inactivity timeout, bounded redirects, and fallback to installed 1.651.510.
  The script is read as text; it is never executed.

The version lookup can report a version different from the installed SDK.
Status records both explicitly. This reproduces reference reporting behavior;
it does **not** update the installed SDK code. To disable lookup deliberately,
set `EARNAPP_VERSION_MODE=local` and recreate the container. For direct Docker
runs, `EARNAPP_VERSION_URL` can override the HTTPS lookup URL.

## Preserving and repairing existing state

Each profile uses `data/<profile>/`. Existing Node state is under `data/default`.
Registration writes a link to `data/<profile>/earnapp.txt` and the convenient
`data/earnapp.txt` file. The latter shows the most recently registered/started
profile. Open the link to associate the device with your account.

```powershell
Get-Content .\data\earnapp.txt
```

For an unregistered saved desktop/mobile identity with a different prefix,
the worker backs up `uuid` as `uuid.before-<platform>-prefix` and changes the
prefix while retaining its 32 hex digits. Registered identities and explicit
UUID overrides are preserved; use a new profile name if their prefix conflicts.
To do that, duplicate the desired entry with a new `name` (for example
`ios-custom`) and select that name with `EARNAPP_CLIENT`.

`EARNAPP_CONFDIR` can override the state path for a direct Docker run. Use only
one running worker per state directory. `down` preserves the bind-mounted data.

## Commands and customization

```sh
docker compose ps
docker compose exec worker node /app/worker.cjs status
docker compose run --rm --no-deps worker check
docker compose stop
docker compose start
docker compose down
```

For registration-only testing, stop the ordinary worker first:

```sh
docker compose stop
docker compose run --rm --no-deps worker register
```

A failure records its transport stage in
`data/<profile>/registration-diagnostic.json`, including whether DNS, TCP, TLS,
request transmission or response reception completed. It omits UUID query
parameters and request bodies. The default registration deadline is 30 seconds.

Edit `sdk/client.js` / `sdk/sdk_conf.js` for SDK customization, `worker.cjs` for
startup, `platform.cjs` for profile selection, `registration.cjs` for the request
flow, and `version.cjs` for version reporting. After JavaScript changes:

```sh
docker compose build
docker compose up -d --force-recreate
```

`EDGE_CONSENT=0` pauses sharing and ordinary startup registration, although SDK
configuration/telemetry can still run. Docker logs are capped; SDK file logs
have their own vendor behavior. The healthcheck measures the local heartbeat,
not backend connectivity or earnings.

## Verification

The reference bundle was instrumented offline to capture real registration
fields and SDK handshake payloads. The historical reference-profile tests match those captured objects
for Node, Tizen, webOS, and the three reported-OS profiles using Node identities.
Golden fixtures are in `tests/reference-fixtures/`. They are outputs of the
reference code, not hand-written expected fields.

Other tests cover actual SDK startup/shutdown with mocked interfaces/registration,
UUID persistence, failed-identity migration, preservation of registered identities,
tracking ID creation, reported-version lookup/fallback, truthy registration
responses, transport timeout stages and aborted responses.

Local tests require Node 24 and Python 3:

```sh
cd sdk
npm ci --ignore-scripts --no-audit --no-fund
cd ..
node worker.cjs check
node tests/reference-registration.cjs
node tests/handshake.cjs ios
node tests/fingerprints.cjs
node tests/migration.cjs
node tests/version.cjs
python -m unittest discover -s tests -v
```

The authoring environment has no Docker daemon, so Docker build/start and live
backend acceptance could not be executed here. Exact offline reference parity
is stronger than the earlier serialization-only tests, but it does not prove
live backend acceptance or earnings. This package fixes the matching-version
and measured wrapper differences; no such live result is claimed.

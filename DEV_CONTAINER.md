# Dev container & ESP log workflow

How to interact with the ESP-IDF dev container and read the ESP32-S3 serial
logs. Kept separate from `.cursor/NOTES.md` (which describes the firmware
itself) so the day-to-day build/flash/monitor recipes live in one place.

---

## 1. The container

Defined in `.devcontainer/` (Dockerfile builds ESP-IDF `v5.5.4`).

- **Name**: `vsc-md-mpx-dog-...` (VSCode-generated). The running instance at
  time of writing is `suspicious_poitras` — auto-generated, so do **not**
  hard-code it; resolve it each time (see below).
- **ESP-IDF**: installed at `/opt/esp/idf`, version `v5.5.4`.
- **IDF_TOOLS_PATH**: `/root/.espressif` (toolchains, python env, tools).
- **Workspace**: mounted at `/workspaces/md-mpx-dog`.
- **`build/`** is a named Docker volume (`mpx-dog-idf-build`), so build
  artifacts persist across container rebuilds.
- **ccache** at `/root/.ccache` (also a named volume).
- **`/dev`** is bind-mounted (see § "device visibility" note below).

Non-root shell can't reach `idf.py` — it's not on PATH until you source the
export script. You must run everything through `source .../export.sh` (or use
the entrypoint shell, which sources it for you).

---

## 2. Prerequisite: source the IDF environment

Every `idf.py` / `esptool` command inside the container needs this first:

```bash
cd /workspaces/md-mpx-dog
source /opt/esp/idf/export.sh   # sets PATH, IDF_PATH, python env
```

After that, `idf.py --version` prints `ESP-IDF v5.5.4`.

---

## 3. Running a command from the host (one-liners)

From the host shell, wrap commands with `docker exec` + `bash -lc`, and source
the export inside it:

```bash
# Resolve the running container name (don't assume "suspicious_poitras"):
docker ps --filter ancestor=vsc-md-mpx-dog --format '{{.Names}}'

# Generic form:
docker exec <container> bash -lc \
  'cd /workspaces/md-mpx-dog && source /opt/esp/idf/export.sh >/dev/null 2>&1 && <command>'
```

Ideal for scripting: put the container name in a variable first.

```bash
CID=$(docker ps --filter ancestor=vsc-md-mpx-dog --format '{{.Names}}' | head -1)
```

---

## 4. Build

```bash
docker exec "$CID" bash -lc \
  'cd /workspaces/md-mpx-dog && source /opt/esp/idf/export.sh >/dev/null 2>&1 && idf.py build'
```

Output land in `build/`, key artifacts:

- `build/MPX-Dog.bin` — app image (ESP32-S3, ~4.9 MB, ~32% free in partition)
- `build/bootloader/bootloader.bin`
- `build/partition_table/partition-table.bin`
- `build/srmodels/srmodels.bin`, `build/system.bin` (flashed to higher offsets)
- `build/MPX-Dog.elf` — for debugging / addr2line

The PWA (`pwa-claw/`) is built with Vite and its assets are embedded into the
firmware as `.S` objects (`index.html.gz.S`, `m.js.gz.S`, ...), so a firmware
build also rebuilds the web UI -- but only **when the web UI actually changed**.

The web build is stamp based, not "every build":

- `tools/pwa_build.cmake` compares the newest mtime of the PWA inputs
  (`pwa-claw/src`, `pwa-claw/public`, the bundler configs, `package-lock.json`)
  with `build/mpx_pwa.stamp` and runs `npm run build` only when an input is
  newer, `www/index.html` is missing, or the stamp is absent.
- It is invoked from two places, both **before** the build graph is evaluated:
  - `idf_ext.py` (project-level `idf.py` extension) runs it as a global action
    callback for `build` / `all` / `app` / `flash` / `app-flash`, so ninja sees
    the fresh timestamps at startup and re-embeds + relinks in the *same*
    invocation (a web build started from inside the graph could only be
    relinked by the next build, i.e. the flashed firmware would embed the
    previous web app);
  - the `mpx_build_pwa` CMake target, for plain `cmake --build build` / `ninja`
    users, where the extension above does not run.
- `npm ci` runs only when `node_modules/` is missing or older than the
  lockfile.
- A fresh clone (`www/` is gitignored) is still handled at **configure** time,
  because `EMBED_FILES` resolves to explicit ninja inputs that must exist.

Timings in this container with a warm `build/`:

| What changed since last build | `idf.py build` |
|-------------------------------|----------------|
| nothing at all | ~3 s |
| `pwa-claw/` (web UI) | ~2 min: `npm run build` ~30 s + re-embed/relink ~90 s |
| anything else | ordinary C rebuild (relink included) |

A C-only change never touches `www/`, so it no longer pays for `npm` or for
re-assembling the ~5 MB of embedded web assets. A web change still relinks,
because the 16 embedded `.S` objects are inputs of `MPX-Dog.elf`.

**Knobs:**

- `MPX_FORCE_PWA=1 idf.py build` -- rebuild the web UI even if the stamp is current
- `MPX_SKIP_PWA=1 idf.py build` -- never run npm, embed `www/` as it is on disk
- `idf.py -DMPX_BUILD_PWA=OFF build` -- no web build at all (no node/npm
  required); the existing `pwa-claw/www/` is embedded as-is
- deleting `pwa-claw/www/` heals itself: the next build notices the missing
  `index.html` and runs `npm ci` / `npm run build`
- `pwa-claw/www/` lives in the source tree, so `idf.py clean` / `fullclean`
  do not delete it

**Useful variants:**

- `idf.py fullclean` — wipe build tree (also clears the named volume contents)
- `idf.py clean` — remove build outputs but keep config
- `idf.py menuconfig` — interactive, needs a TTY (open a shell with `-it`)
- `idf.py reconfigure` — after touching `sdkconfig` / `CMakeLists.txt`
- `idf.py host-test` — build and run the host unit tests in `tools/host_tests/`
  (robot ID format, key derivation). No board, no flash; it shells out to cmake
  and ctest. CI runs the same commands directly, so this is only a shortcut.

`sdkconfig` is **not** in version control. It is per-machine output of
`menuconfig`; the committed configuration is `sdkconfig.defaults`. After
`git rm --cached sdkconfig` (Stage 0 of `docs/FIRMWARE_IMPLEMENTATION_PLAN.md`)
the identity source and every other setting no longer come from whoever built
last. A fresh clone therefore has no `sdkconfig`, which is fine — the build
creates it — but it also means the target is no longer recorded anywhere:
pass `-DIDF_TARGET=esp32s3` or run `idf.py set-target esp32s3` first.

### Giving your board its own identity

Out of the box a checkout boots as `MPX-DOG-01` with the published AES key, so
two bench robots on one gateway are the same robot and the key is in `docs/`.
Write a unique `DEV-` ID and a random key into your own `sdkconfig` (rebuild
afterwards):

```bash
python3 tools/mpx_dev_identity.py show    # what this checkout boots as
python3 tools/mpx_dev_identity.py apply   # new DEV- id + random key
```

`apply` refuses to overwrite an identity that is already set (`--force` if you
really mean it) and never writes `sdkconfig.defaults` — a default with a random
key in it would give every clone the same "unique" identity. `show` prints the
key's fingerprint, which is safe to paste into a bug report.

---

## 5. Flash

The build prints the exact command. Flash an ESP32-S3 at `PORT`:

```bash
# inside container:
idf.py -p /dev/ttyUSB0 flash          # build + flash
idf.py -p /dev/ttyUSB0 flash monitor  # flash then open serial monitor

# or raw esptool (printed by build):
python -m esptool --chip esp32s3 -b 460800 --before default_reset \
  --after hard_reset write_flash --flash_mode dio --flash_size 16MB \
  --flash_freq 80m \
  0x0 build/bootloader/bootloader.bin \
  0x8000 build/partition_table/partition-table.bin \
  0x10000 build/MPX-Dog.bin \
  0x710000 build/srmodels/srmodels.bin \
  0x810000 build/system.bin
```

> Note: use `--flash-mode` / `--flash-size` / `--flash-freq` on newer esptool;
> the single-word forms are deprecated.

`idf.py flash` is "build, then write", all in one invocation. Thanks to the
stamp-based web build (section 4) a flash with no PWA change skips `npm`
entirely -- ~3 s of build work plus the write itself. When the web UI did
change, the same run rebuilds and relinks it first (so the flashed image is
never stale).

Faster alternatives once the app is already built:

```bash
# inside container, from /workspaces/md-mpx-dog
idf.py -p /dev/ttyUSB0 app-flash   # app image only -- no bootloader / table / fs
ninja -C build flash               # what `idf.py flash` runs underneath
```

---

## 6. Reading the ESP serial logs

### Monitor

```bash
idf.py -p /dev/ttyUSB0 monitor     # Ctrl+] to exit
```

- **IDF monitor** decodes backtraces, panics, and `abort()` output
  (source lines, function names) using the current ELF. Best choice for
  crashes (WDT, LoadProhibited, etc.).
- Baud is the SDK default (usually 115200), matching `sdkconfig`.

### Raw serial (miniterm / screen)

```bash
python -m serial.tools.miniterm /dev/ttyUSB0 115200   # Ctrl+] to exit
# or
screen /dev/ttyUSB0 115200                            # Ctrl-a k to exit
```

Prefer IDF monitor — it gives decoded panic output for free.

### Live log notes

- `idf.py monitor` (and miniterm) are **interactive** and must be run with a
  TTY: `docker exec -it "$CID" ...`.
- Monitor output is not captured in CI; for scripted capture use miniterm with
  a redirect, or `idf.py monitor --no-reset` piped to a file.
- To grab a log without a device: the firmware boot log + crash trace may also
  be retrievable over the Wi-Fi UART/console if enabled, but the primary path
  is the USB serial.

---

## 7. Device visibility gotcha

`devcontainer.json` bind-mounts `/dev` into the container and runs `--privileged`,
so `/dev/ttyUSB*` / `/dev/ttyACM*` **should** appear inside the container when a
USB-serial adapter is plugged into the **host**.

However, as of the last check there was **no** real USB serial device present —
only the host's `ttyS0..31` (which fail to open). So:

```bash
# inside container, list USB serial devices actually attached:
ls -l /dev/ttyUSB* /dev/ttyACM* 2>/dev/null
```

If a device was plugged in *after* the container started, the bind mount of
`/dev` may not pick it up (or the container needs `--device=/dev/ttyUSB0`).
Common fixes:

1. Restart the container / re-open the dev container window.
2. Or add the device explicitly:
   ```bash
   docker exec --privileged "$CID" ls -l /dev/ttyUSB*
   ```
   and if missing, attach it:
   ```bash
   CONT=$(docker ps --filter ancestor=vsc-md-mpx-dog -q | head -1)
   docker update --device=/dev/ttyUSB0 "$CONT"
   ```
3. Verify the host can see it first: `ls -l /dev/ttyUSB* /dev/ttyACM*`, then
   check the container with the commands above.

Rule of thumb: check the host `ls /dev/ttyUSB*` first; if the host doesn't see
it, the container can't either.

---

## 8. Quick reference

| Task | Command (host shell) |
|------|----------------------|
| List dev container | `docker ps --filter ancestor=vsc-md-mpx-dog` |
| Enter shell | `docker exec -it "$CID" bash` (then `source /opt/esp/idf/export.sh`) |
| Build | `docker exec "$CID" bash -lc 'cd /workspaces/md-mpx-dog && source /opt/esp/idf/export.sh >/dev/null 2>&1 && idf.py build'` |
| Flash | append `idf.py -p /dev/ttyUSB0 flash` (build + write; skips `npm` when `pwa-claw/` is unchanged) |
| Flash app only | append `idf.py -p /dev/ttyUSB0 app-flash` |
| Monitor | `docker exec -it "$CID" ... idf.py -p /dev/ttyUSB0 monitor` (`--no-reset` to not reboot) |
| List USB serial | `docker exec "$CID" ls -l /dev/ttyUSB* /dev/ttyACM*` |
| ELF to source (crash addr) | `docker exec "$CID" ... /opt/esp/idf/tools/xtensa-esp32s3-elf/bin/xtensa-esp32s3-elf-addr2line -e build/MPX-Dog.elf <addr>` |

Container name is auto-generated; always resolve with `docker ps`, never
hard-code it.

# chrome-fp

Launches a real, interactive Chrome window in a throwaway profile with a **new
fingerprint on every run**. No npm dependencies — plain Node 22 + the Chrome you
already have installed.

```bash
./chrome-fp --app                 # desktop app: open/close instances on demand
./chrome-fp --gui                 # same thing, but in the terminal
./chrome-fp                       # fresh identity, blank tab
./chrome-fp https://example.com   # fresh identity, open a URL
./chrome-fp --check               # fresh identity, open a fingerprint test page
```

Close the browser window and the profile (cookies, storage, cache, history) is
deleted automatically.

## Desktop app

```bash
npm install          # once, pulls in Electron
./chrome-fp --app    # or: npm run app
```

A small control panel window that launches and manages real Chrome instances —
the browsing still happens in your actual Chrome, so the fingerprint stays
authentic (an Electron window would be trivially detectable as Electron).

* **Launch instance** with a chosen OS to impersonate and a start URL.
* **Advanced options**: timezone/locale (including *Match my computer*, which
  avoids the VPN flag), a seed to replay an identity, a proxy, canvas/audio
  noise, and bubblewrap isolation.
* **Login-safe** checkbox for sites that refuse automated browsers (Google
  sign-in); it disables the spoofing options, because nothing is injected.
* **Preview identity** shows the fingerprint that would be generated, without
  launching anything.
* Each row shows live status, the identity, open tab count and uptime, with
  **Open URL**, **Details** (full fingerprint + profile path) and **Close**.
* Closing a Chrome window yourself removes its row; closing the control panel
  shuts every instance down and wipes all profiles.

## Terminal UI

`./chrome-fp --gui` starts a small manager in your shell. Each instance you
launch from it is a separate Chrome with its own fingerprint and its own
throwaway profile, and they all run at the same time:

```
 chrome-fp  2 instance(s), 2 running
────────────────────────────────────────────────────────────────────────
 #   STATUS    OS       IDENTITY                                 TABS  UPTIME
 1   running   linux    en-CA · Vancouver · 1600x900 · 4c/32GB…  2     03:41
 2   running   windows  pt-BR · Sao_Paulo · 1536x864 · 4c/8GB…   1     00:52
────────────────────────────────────────────────────────────────────────
 n new  ·  l/w/m new linux/win/mac  ·  c new + fp test  ·  o open URL
 ↑/↓ select  ·  x close  ·  X close all  ·  i details  ·  q quit
```

| Key | Action |
| --- | --- |
| `n` | Launch a new instance with a brand-new fingerprint |
| `l` / `w` / `m` | New instance impersonating Linux / Windows / macOS |
| `c` | New instance that opens a fingerprint test page |
| `g` | New **login-safe** instance (Google sign-in works, no spoofing) |
| `o` | Open a URL in the selected instance (new tab) |
| `↑`/`↓` or `j`/`k`, or `1`-`9` | Select an instance |
| `x` | Close the selected instance (profile wiped) |
| `X` | Close every instance |
| `i` | Show the full fingerprint of the selected instance |
| `q` / `Ctrl+C` | Close everything and exit |

Closing a Chrome window yourself also shuts that instance down and removes it
from the list. Flags like `--proxy`, `--bwrap` and `--os` apply to every
instance started from the UI: `./chrome-fp --gui --bwrap --proxy socks5://127.0.0.1:9050`.

## What changes on every run

| Signal | How it is spoofed |
| --- | --- |
| User-Agent + `navigator.userAgentData` (full client hints: platform, platform version, architecture, bitness, full version list) | CDP `Emulation.setUserAgentOverride`, so HTTP headers and JS agree |
| `Accept-Language`, `navigator.languages`, `Intl` locale | CDP locale override + `--lang` |
| Timezone (`Intl`, `Date`) | CDP timezone override + `TZ` env |
| Screen size, avail size, orientation, color depth | JS patch, plus a matching real window size/position |
| CPU cores, device memory, `navigator.platform`, touch points, network `rtt`/`downlink` | CDP hardware-concurrency override + JS patches |
| WebGL unmasked vendor/renderer (GPU model, consistent with the OS) | JS patch of `getParameter` |
| Canvas hash (`toDataURL`, `toBlob`, `getImageData`) | sparse, seeded pixel noise |
| WebGL `readPixels` hash | seeded byte noise |
| AudioContext hash | seeded sample noise (~1e-7, inaudible) |
| Font / text metrics (`measureText`, `getClientRects`) | seeded sub-pixel noise |
| `navigator.webdriver` | Blink's automation flag disabled at launch, plus a JS fallback |
| Cookies, localStorage, cache, history | brand-new temp profile each run |

The noise is **stable inside a run** (a site that measures the same canvas twice
gets the same hash — re-measuring and getting different values is itself a bot
signal) and **different between runs**.

Everything is injected through the DevTools protocol *before* any page script
runs, and it is re-applied to every new tab, window, **iframe and worker**.
That coverage matters: commercial detectors deliberately read WebGL, canvas and
`navigator.webdriver` from a freshly created blank iframe or from a Web Worker
(via `OffscreenCanvas`) to bypass page-level patching. `node test/leaks.js`
checks each of those contexts. Patched functions keep native `toString()` output, so
`HTMLCanvasElement.prototype.toDataURL.toString()` still reports
`function toDataURL() { [native code] }`.

## Options

```
--os <linux|windows|macos>  Platform to impersonate            (default: linux)
--seed <string>             Reproduce a previous fingerprint
--locale <tag>              Force locale, e.g. de-DE ("auto" = host locale)
--tz <zone>                 Force timezone, e.g. Europe/Berlin
                            ("auto" = host timezone, matches your real IP)
--proxy <server>            e.g. socks5://127.0.0.1:9050
--login-safe                No DevTools attach: works with Google sign-in,
                            but only isolates the profile (no spoofing)
--no-noise                  Disable canvas/WebGL/audio/text noise
--keep-profile              Keep the temp profile after exit
--profile-dir <path>        Use a specific profile dir (implies --keep-profile)
--bwrap                     Extra OS-level isolation via bubblewrap
--app                       Desktop app (Electron) to open/close instances
--gui                       Terminal UI to open/close several instances
--check                     Open a fingerprint test page
--print                     Print the generated fingerprint and exit
--json                      Print the fingerprint as JSON
```

Every run prints its seed, and the fingerprint is also saved to
`<profile>/fingerprint.json`. Re-running with `--seed <value>` reproduces that
exact identity — useful when you want to look like the *same* person again:

```bash
./chrome-fp --print                 # try identities without launching
./chrome-fp --seed my-shop-account  # same identity every time
```

## Sandboxing

A fresh, isolated profile is always used. `--bwrap` adds OS-level isolation on
top via [bubblewrap](https://github.com/containers/bubblewrap): read-only root
filesystem, empty `$HOME`, private `/tmp`, own PID namespace, and
`--die-with-parent`. Chrome's own sandbox keeps working inside it.

```bash
./chrome-fp --bwrap https://example.com
```

## Install

```bash
npm install                                     # only needed for --app (Electron)
ln -s "$PWD/chrome-fp" ~/.local/bin/chrome-fp   # run from anywhere
```

## Packaged builds

```bash
npm run pack:linux   # AppImage + .deb
npm run pack:win     # NSIS installer + portable .exe  (needs wine on Linux)
npm run pack:all     # everything, into dist/
```

| Artifact | Platform |
| --- | --- |
| `chrome-fp-<version>.AppImage` | Linux, run it directly (`chmod +x`) |
| `chrome-fp_<version>_amd64.deb` | Debian/Ubuntu/Mint, `sudo apt install ./chrome-fp_*.deb` |
| `chrome-fp-<version>-setup-x64.exe` | Windows installer (per-user, choosable location) |
| `chrome-fp-<version>-portable-x64.exe` | Windows, no install |

The packages ship the **control panel only** — they drive the Google Chrome
already installed on the machine (auto-detected, or set `CHROME_PATH`). The
builds are unsigned, so Windows SmartScreen will warn on first run.
`--bwrap` isolation is Linux-only and is hidden in the UI elsewhere.

Chrome is auto-detected (`google-chrome`, `chromium`, …); override with
`CHROME_PATH=/path/to/chrome`.

## Verify it works

```bash
node test/verify.js            # prints exactly what a page observes
node test/verify.js --seed a   # same seed -> identical values
node test/verify.js --os windows
node test/leaks.js             # checks iframes, workers and CDP traces
```

`CHROME_FP_DEBUG=1` logs failing CDP commands, `CHROME_FP_DEBUG=2` traces every
CDP command per target.

## Signing in to Google (and other sites that block automation)

Google refuses sign-in with **"This browser or app may not be secure"** whenever
Chrome is started with `--remote-debugging-port` or `--remote-debugging-pipe` —
and that DevTools attachment is exactly how the fingerprint patches are
injected. It is a browser-level signal, so no amount of JS spoofing hides it.

Use login-safe mode for those sessions:

```bash
./chrome-fp --login-safe https://accounts.google.com
```

in the terminal UI press `g`, or tick **Login-safe** in the desktop app.

What you get and what you give up:

| | Normal mode | Login-safe mode |
| --- | --- | --- |
| DevTools attached | yes | **no** |
| Fingerprint spoofing (screen, GPU, canvas, UA…) | yes | no — your real values |
| Fresh isolated profile (cookies, storage, history) | yes | yes |
| Language / timezone / window size | randomized | taken from your machine by default |
| Proxy, bubblewrap | yes | yes |
| Google / bank sign-in | usually blocked | works |

So login-safe gives you **identity separation** (a clean container per account)
rather than a new fingerprint. That is normally what you want for logging in:
a brand-new fingerprint on an account you have used before is itself suspicious.

## Still flagged by a bot check?

Anti-fraud services report several independent signals. Map the verdict to the
right cause before changing anything:

| Verdict | Cause | What to do |
| --- | --- | --- |
| `bot: webdriver` / automation detected | A context escaped patching, or Blink's automation flag is on | Should be fixed; confirm with `node test/leaks.js` — every `*.webdriver` must be `false` and every `*.gpu` must match |
| `vpn: true`, `timezone_mismatch: true` | The spoofed timezone doesn't match the country of your IP | Run with `--tz auto` (uses your real timezone), or use `--proxy` with an exit node in the spoofed region |
| `proxy`/`ip_blocklist`/datacenter flags | Your IP, nothing to do with the fingerprint | Change exit IP; no browser setting can fix this |
| `rare_device: true` | Inherent: a brand-new random fingerprint has never been seen before | Reuse `--seed <name>` for an identity you want to look "returning" |
| `incognito`, `developer_tools` | Not triggered by this tool | — |
| `tampering: true` | Noise or spoofing looked inconsistent | Try `--no-noise`, and prefer `--os linux` on this machine |
| Google: "This browser or app may not be secure" | The DevTools attach needed for injection | Use `--login-safe` (see above) |

A fresh fingerprint on every run is the opposite of what a *returning human*
looks like. If a site should see a consistent person, launch it with a fixed
`--seed` (and keep the same `--proxy`), and only randomize when you actually
want a new identity.

## Limitations — read this

* **Your IP address does not change.** It is the strongest identifier there is.
  Pair with `--proxy` or a VPN if the goal is separate identities.
* **Installed fonts are real.** Text-metric noise perturbs measurements, but a
  full font-enumeration probe still reflects your system. Impersonating Windows
  or macOS from Linux is therefore detectable by a determined fingerprinter;
  the default `--os linux` is the most coherent choice on this machine.
* Behavioural signals (typing, mouse movement) are untouched.
* Workers are patched by wrapping the `Worker`/`SharedWorker` constructor: the
  real script is loaded from a small bootstrap blob. `self.location`,
  `importScripts`, `fetch` and `XMLHttpRequest` are corrected to resolve against
  the original script URL, and module workers queue/replay early messages, but
  an exotic worker setup could still behave differently.
* Noise defeats hash-based tracking, but *very* aggressive anti-bot services can
  flag the noise itself. `--no-noise` gives a clean, non-randomized canvas if a
  site breaks or you get challenged more than usual.

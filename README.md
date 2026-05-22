# Unofficial Evo Remote

Drive an Ozobot Evo like a remote-controlled car from Chrome. No account,
registration, or email required: connect the robot, press the buttons, and
watch it move in real time.

Live app: [https://unofficial-evo-remote.pages.dev](https://unofficial-evo-remote.pages.dev)

This is an unofficial project. It is not made by, endorsed by, or affiliated
with Ozobot.

## Use

Open the hosted site in Chrome, choose an Evo from Chrome's Bluetooth device
picker, then hold the on-screen arrows or `W/A/S/D` / arrow keys to drive.

The light swatches let students choose a robot color. `Set Color` turns the
selected color on for the front/top lights, `Lights Off` clears those lights,
and `Flash Color` blinks the connected robot in the selected color so students
can identify which Evo they selected. The effect buttons can run simple light
animations such as blink, pulse, rainbow, and red/blue while students drive.
Sound buttons play short tone patterns. `STOP`, `Space`, and `Escape` send an
immediate stop.

Only connect to robots you own or are authorized to control.

## Browser Requirements

- Chrome or another Chromium browser with Web Bluetooth support.
- Bluetooth available on the computer.
- HTTPS when hosted online.
- `localhost` is okay for local testing.

Safari and Firefox do not currently support the Web Bluetooth API needed by this
app.

## Troubleshooting

- Use Chrome on a desktop or Chromebook with Bluetooth enabled.
- Use the hosted HTTPS site or a local `localhost` preview.
- Wake up or charge the Evo before connecting.
- If the wrong robot connects, choose a bright swatch and click `Flash Color` to
  identify it.
- If a light effect is still running, click `Stop Effect`.
- If the lights stay on after testing, click `Lights Off`.
- If driving feels choppy, disconnect and reconnect, move closer to the robot,
  or reduce the number of active Bluetooth devices nearby.

## Known Limitations

- Chrome's Bluetooth device picker is required; browsers do not expose a custom
  in-page scan list for Web Bluetooth.
- The app is intended for Ozobot Evo robots.
- The app does not bypass pairing, classroom management, or device access
  controls.
- This is an unofficial project and is not affiliated with Ozobot.

## Local Preview

Serve the folder with any static file server:

```sh
python3 -m http.server 8765 --bind localhost
```

Then open:

```text
http://localhost:8765
```

## Cloudflare Pages

This app is zero-build static HTML/CSS/JS.

Production deploys from the `main` branch on Cloudflare Pages, watching all
repo files for changes.

Suggested Cloudflare Pages settings:

- Framework preset: none/static
- Build command: leave blank
- Build output directory: `/`
- Production branch: `main`

Web Bluetooth requires HTTPS for deployed sites, so use the Cloudflare
`pages.dev` URL or a custom HTTPS domain.

## Protocol

The app talks to current Evo robots through the control-service characteristic:

```text
service:        8903136c-5f13-4548-a885-c58779136801
characteristic: 8903136c-5f13-4548-a885-c58779136802
```

Drive commands use the control-service velocity request (`104`). On connect, the
app sends stop-execution (`120`) to clear any running robot behavior before
direct control. Light controls use the set-LED request (`110`).

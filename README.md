# axcel-phone

The phone half of [Axcel](https://github.com/rbattiston/Project-Axcel): a small
web app that records an nRF52840 fitness sensor's Bluetooth stream while you
lift, and hands the raw bytes back for analysis on a laptop.

Open it on **Chrome for Android** and install it to the home screen. iOS Safari
has no Web Bluetooth and will not work.

It stores two things: the raw BLE byte stream, verbatim, and the set labels you
type. Everything on screen is decoded only for display and thrown away -- the
authoritative parser lives in the main project, so a bug here costs a misleading
screen and nothing more.

No analytics, no network calls, no account. Recordings never leave your phone
until you export them.

Generated from `phone/` in the main repository; edit it there.

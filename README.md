# Vibbit

Describe what you want in plain English, and Vibbit writes the MakeCode blocks
for your BBC micro:bit.

It runs inside the MakeCode editor as a Chrome extension. You type something
like *"show a heart when I press button A"*, and Vibbit generates the code,
checks it converts cleanly to blocks, and pastes it into your project.

> Fork of [tinkertanker/vibbit](https://github.com/tinkertanker/vibbit), with
> extension support, editor detection, and classroom features added.

---

## Contents

- [What you need](#what-you-need)
- [Get a free Google API key](#get-a-free-google-api-key)
- [Install Vibbit](#install-vibbit)
- [Your first prompt](#your-first-prompt)
- [Writing good prompts](#writing-good-prompts)
- [Using extensions](#using-extensions)
- [Watching your daily limit](#watching-your-daily-limit)
- [Troubleshooting](#troubleshooting)
- [For teachers](#for-teachers)
- [For developers](#for-developers)

---

## What you need

- **Google Chrome** (or Edge). Vibbit is a Chrome extension.
- **A free Google account**, for the API key.
- **A micro:bit**, if you want to run the code on real hardware. The MakeCode
  simulator works fine without one.

---

## Get a free Google API key

An API key is a password that lets Vibbit talk to Google's AI. It's free, takes
about two minutes, and does **not** need a credit card.

**1. Open Google AI Studio**

Go to <https://aistudio.google.com/apikey> and sign in with your Google account.


**2. Create the key**

Click **Create API key**. If it asks you to pick a project, choose the default
one it offers.

<img width="1898" height="1012" alt="image" src="https://github.com/user-attachments/assets/9d159cd5-9322-43c1-8458-5b40f2874034" />

<img width="1443" height="169" alt="image" src="https://github.com/user-attachments/assets/f4b79d78-ed25-465e-8562-6eecdbf9ec82" />

<img width="517" height="285" alt="image" src="https://github.com/user-attachments/assets/75b7fcb3-56ca-4f61-bcce-9e7f2c7a6f68" />

**3. Copy it**


<img width="518" height="486" alt="image" src="https://github.com/user-attachments/assets/b231c6ee-b3e5-49d8-858c-7ed4d2ee3295" />
You'll get a long string starting with `AIza...`. Click the copy button.

**4. Keep it private**

Treat it like a password:

- Don't post it in a group chat, a shared doc, or on GitHub.
- Don't paste it into a screenshot.
- If you think someone else has seen it, go back to AI Studio and delete it,
  then make a new one.

If you lose it, you can't view it again. Just create a new one.

### What "free" actually means

The free tier has **no expiry and no credit card**, but it does have daily
limits on how many requests you can make. Vibbit shows you a counter so you can
see where you stand — see [Watching your daily limit](#watching-your-daily-limit).

One more thing worth knowing: on the free tier, Google may use what you send to
improve their models. Don't paste anything private or personal into Vibbit.

Google changes these limits from time to time. The current figures for your own
key are in [AI Studio](https://aistudio.google.com/).

---

## Install Vibbit

Vibbit isn't on the Chrome Web Store yet, so you install it manually. It's not
hard.

**1. Get the extension files**

Download `vibbit-extension.zip` from the
[Releases page](https://github.com/fablabSP/vibbit/releases), then unzip it.
You should end up with a folder containing `manifest.json`.

**2. Open Chrome's extensions page**

Type `chrome://extensions` in the address bar and press Enter.

**3. Turn on Developer mode**

The toggle is in the top-right corner.

**4. Load it**

Click **Load unpacked**, then select the unzipped folder.

Vibbit should now appear in your extensions list.

**5. Add your key**

Open a MakeCode project, click the Vibbit button, then the gear icon. Choose
**Gemini** as the provider and paste your API key.

---

## Your first prompt

**1. Open a project, not the home page.** Go to
<https://makecode.microbit.org> and open or create a project. Vibbit needs the
editor, not the project list.

**2. Check the pill.** Top of the Vibbit panel, next to the version number:

| Pill | Meaning |
|---|---|
| 🟢 Editor connected | Ready to go |
| 🟡 Editor loading | Click the pill, or open the JavaScript tab |
| 🔴 No project open | You're on the home page — open a project |

**3. Try a starter.** Click one of the chips (Beating heart animation, Random
dice, Rock paper scissors...). It fills the box so you can see what a good
prompt looks like. Change anything you like, then hit **Send**.

**4. Watch it work.** Vibbit generates the code, checks it converts to blocks
without errors, retries if something's wrong, then pastes it in.

---

## Writing good prompts

Vibbit works best when you're specific. Compare:

| Vague | Specific |
|---|---|
| "make a game" | "when I shake it, show a random number from 1 to 6" |
| "use the LEDs" | "light up 8 NeoPixels on pin P1 in rainbow colours" |
| "detect something" | "show a skull when the ultrasonic sensor reads under 10 cm" |

Things worth including:

- **Which pin** your hardware is on (P0, P1, P2...)
- **How many** of something (8 LEDs, 6 dice faces)
- **What triggers it** (button A, shake, a card being scanned)
- **What should happen** (show a number, play a tone, move a servo)

Say the whole idea in one message. Two half-prompts cost twice as many requests
as one complete prompt.

---

## Using extensions

Some hardware needs an **extension** — an add-on library — before the code will
run. Vibbit knows about these:

| Hardware | Extension | Say something like |
|---|---|---|
| NeoPixel / LED strip | `neopixel` | "rainbow on 8 neopixels on P1" |
| Ultrasonic distance | `sonar` | "measure distance with the ultrasonic sensor" |
| Bluetooth keyboard/mouse | `blehid` | "send a keypress to my computer over bluetooth" |
| NFC / RFID cards | `NFC` | "read an RFID card and show the UID" |
| Servo motor | *(built in)* | "move a servo on P1 to 90 degrees" |

**Add the extension before you prompt.** In MakeCode: gear icon →
**Extensions** → search the name → click it.

Vibbit shows an amber banner above the input box when your prompt needs an
extension you haven't added yet.

### Bluetooth HID needs two extra steps

- It only works on **micro:bit V2**.
- You must set **Project Settings → No Pairing Required** before your computer
  can connect.

### NFC needs the expansion board

The NFC blocks talk to a DFRobot PN532 module over I2C. A bare micro:bit won't
do anything on its own.

---

## Watching your daily limit

The header shows **"N left today"** next to the version number. Hover it for a
breakdown.

It counts **requests**, not prompts. One prompt can cost several requests if
Vibbit has to retry — so 5 prompts might use 8 requests.

When you drop below 30% remaining, a banner appears with tips for stretching
what's left. The main ones:

- **One complete prompt beats two vague ones.** Say the pin, the numbers, and
  the trigger up front.
- **Edit blocks by hand for small changes.** Changing a colour or a delay in
  the editor costs nothing.
- **Draft your prompt in a free chatbot first.** Ask Gemini, ChatGPT, or
  Copilot something like *"rewrite this into one clear instruction for a
  micro:bit block coding assistant, including the pin and the trigger"*, then
  paste the polished version into Vibbit. Those chatbots are free and don't
  touch your API quota.
- **Read your prompt once before sending.** A failed generation costs the same
  as a good one.

The counter is a guide, not the real limit — the actual quota lives with
Google. It's per-browser and resets daily.

---

## Troubleshooting

**"No project open"** — You're on the MakeCode home page. Open a project.

**"Editor loading" won't go green** — Click the pill. If it stays amber, click
the **JavaScript** tab at the top of MakeCode, then try again.

**"The AI service is busy"** — Google's servers are full. Vibbit retries
automatically. If it gives up, wait a minute.

**"The AI service is rate limited"** — You've hit your daily or per-minute
limit. Check the counter in the header. Daily limits reset at midnight Pacific
time.

**"That API key was rejected"** — Check for a stray space when you pasted it,
or make a new key in AI Studio.

**The code has red squiggles** — Usually a missing extension. Check the amber
banner, and add the extension in MakeCode.

**Nothing happens when I click the Vibbit button** — Reload the extension at
`chrome://extensions`, then refresh your MakeCode tab.

**Wrong version showing** — The version number in the header tells you which
build is loaded. If it's older than expected, you're running a stale copy.
Re-download and reload.

---

## For teachers

**Use Managed mode for a class.** One API key lives on your server, students
enter a classroom code. Nobody handles keys, nobody sees yours. Setup is in the
[developer guide](docs/development.md).

**Free tier will not survive 20 simultaneous students.** When a whole class
sends at once, you'll exceed the per-minute limit immediately. Vibbit spreads
the burst out and retries, which helps, but a paid key is what actually solves
it. The cost is cents per lesson — set a spend cap and it's bounded.

**Pre-load a starter project.** Make one MakeCode project with the extensions
your lesson needs already added, and share that link. Saves ten minutes of
setup and a lot of confusion.

**Budget on requests, not prompts.** With retries, assume roughly 1.5 to 2
requests per student prompt.

---

## For developers

Build instructions, backend deployment, the shared compat core, and the release
process are in **[docs/development.md](docs/development.md)**.

Quick start:

```bash
npm install
npm test
npm run release:patch    # bumps version and packages the extension
```

Editing rule: `work.js` contains a **generated** copy of
`shared/makecode-compat-core.mjs` between the `BEGIN_SHARED_COMPAT_CORE` and
`END_SHARED_COMPAT_CORE` markers. Never edit that block by hand — edit
`shared/`, then run `npm run sync:compat-core`.

---

## Credits

Originally created by [Atharv Pandit](https://github.com/Avi123-codes) and
[Josiah Menon](https://github.com/OsiahMelon), Raffles Institution, 2025.
Maintained upstream by [Tinkertanker](https://github.com/tinkertanker).

Licensed under the terms of the upstream repository.

# SeeingPink

**The governed assistant. Your machine, your record, your rules.**

ThinkPink (beta) is an assistant that runs at home: local models by
default, a governance gate that files receipts for its decisions, and
one watched cloud lane at most. Your context stays yours; the record
does the remembering, and the record is a folder you own.

Free for everyone. Nobody sells this packaging.

- Founder: Cecil Pink
- Governance mapped from the Stardust Lab's ratified Code of Ethics

## What is in this repository

- `app/` - the ThinkPink application source: the local web shell and
  the desktop wrapper. The desktop build signs itself ad hoc at
  package time so Gatekeeper shows the ordinary "unidentified
  developer" path instead of a damaged-file error.
- `kernel/` - the PINK starter kernel, carried verbatim: kernel.md
  (the resident), BOOT.md (cold start), and its README. One kernel,
  many envelopes; the first-person kernel.md is canonical.
- `STARTUP-PLAIN.md` - a startup guide written for people who have
  never run a local model, with the science and its sources.
- `LICENSE` - the packaging license (CC BY-NC-SA 4.0).
- `NOTICE-THIRDPARTY.md` - upstream credits. Hindsight, by Vectorize
  AI, Inc., is MIT and stays under its own license.

## Status

Beta. Built in the open and tested so far in private family testing.
Nothing goes to market until it is thoroughly tested in the cloud and
with scientific partners. Support runs through GitHub issues on this
repository.

## Build it yourself

```
cd app
npm install
npm run build

```

The desktop package target uses electron-builder; see
`app/package.json`. The startup guide walks through the model side
(Ollama) step by step.

## In honorable and esteemed memory of Aaron Schwartz. https://en.wikipedia.org/wiki/Aaron_Swartz - C. Pink

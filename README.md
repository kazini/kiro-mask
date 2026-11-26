# Kiro Mask
> [!NOTE]
> <sub>This project was developed with Agentic LLM assistance. Its planning, specifications, criteria, and systems-design were directed, in detail, by a human developer. Most of the code was written by an LLM and has not been fully reviewed by a human developer, despite passing test validations; it is *not* up to production standards. You have been warned!</sub>
___
Lets Kiro IDE use custom model endpoints. It starts Kiro through a local MITM proxy that makes itself look like AWS, and translates the protocol to OpenAI or Anthropic formats.

### <sub>**Always open to contributions and suggestions!**</sub>
___

#### Running KiroMask:
On Windows, use `run_kiromask.cmd`; untested on Linux, but should work. Before running, you have to configure `kiromask.config.yaml` and either set the exe path location or, for autodetection, place a shortcut for the Kiro folder or .exe in the kiromask directory, copy the kiromask directory into or drop its contents on the main Kiro folder. 

Needs Node 18.18 or newer. Use `node kiromask.mjs` to run directly. Use `node kiromask.mjs init` to auto-generate a config file from the example. Kiro IDE will open automatically.

`kiromask.config.yaml` has every option explained. Whatever is written (certificate, logs, captures) goes in `data/` which will definitely contain some sensitive information about your activity.

___
### <sub>Other Directories:</sub>
> `_kiromask_diag-n-test` is a development folder for tools used to capture Kiro's traffic and diagnose problems, the tests for kiromask, and notes on the protocol.

> `.kiropipe-py_archived` is the old python version, deprecated. Some people might prefer python or use it as a reference, so it is archived here. Feel free to contribute if interested, we'll scrape off the 'archive' name.

> `_kiromask-src/_legal` holds the [legal position](./_kiromask-src/_legal/LEGAL_POSITION.md) on running Kiro Mask alongside Kiro IDE, with a dated copy of the terms at the time. A just-in-case statement for peace of (my) mind.
___

#### To-Do List:
```
- test max context usage and compression limits
	* context usage seems to not be calculated based on total chat or sent context size, but on the recently sent message alone?
	* more testing is required after port. additionally, should change config keys to take 'auto' and make that the new default, and for the hard defaults to fall back to auto *or* a fixed item when a hard number fails, with the adjustment methods we have set up now

- test custom completions model
	* more testing required after port

> use kiro-cli as an imported github module, to automate the extraction of the protocol and adapt to its changes across Kiro updates and demanding less maintainability for the project

> system prompt injector with priority based on labels, replace the "entire prompt" swap -- these should go into files, with their location set in the config (default "steering" folder in the kiromask folder)

> improve target selector for free models vs finding usage for credit and context calculation
- remove "credits used" outputted in chat for custom models.
- make sure that debug messages and regular messages are differentiated / some regular messages should definitely only be showing up under debug, methinks.
```

___
<sub>Copyright 2026 Camilo Jourdan — [Kiro Mask](https://github.com/kazini/kiro-mask) | [PolyForm Noncommercial 1.0.0](./LICENSE) — free for non-commercial use, modifications and new works.</sub>

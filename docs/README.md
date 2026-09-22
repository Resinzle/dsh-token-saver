# Documentation

Pick the version that matches who you are and what you need.

## Introductions — start here

Four versions of the same story. The technical and plain-language versions describe the same system; they differ in what they assume you already know, not in what they claim.

| | Plain language | Technical |
|---|---|---|
| **中文** | [这套东西是什么（小白版）](intro-beginner.zh.md) | [这套东西是什么（技术版）](intro-professional.zh.md) |
| **English** | [What this is (plain language)](intro-beginner.en.md) | [What this is (technical)](intro-professional.en.md) |

Every number in all four comes from the same measurements and can be reproduced with the commands in [measurements.md](measurements.md). None of them are estimates.

## Reference

| Document | Answers |
|---|---|
| [install-with-ai.zh.md](install-with-ai.zh.md) | **给 AI 的安装说明（中文）。** Paste it into an AI assistant and it installs the plugin and verifies each step. Written for someone who does not use a command line, and it states plainly that installing the plugin alone saves almost nothing — the spill cap is a configuration value |
| [architecture.md](architecture.md) | How the four mechanisms work, why each exists, and which measurement forced each decision |
| [measurements.md](measurements.md) | Every measured number, with the command that produces it |
| [compatibility.md](compatibility.md) | Which harness versions are verified, what to check after an upgrade, and how to rebuild all four mechanisms if this plugin never works again |
| [troubleshooting.md](troubleshooting.md) | Failure modes, symptom by symptom — including the credential bug that made hosted delegation return 401 on every call |
| [publishing.zh.md](publishing.zh.md) | 从零发布到 GitHub 的逐步指引（中文），含本机实测的网络结论与 token 安全边界 |
| [sponsor.md](sponsor.md) | Sponsorship: how to tip, and what a tip does and does not buy. Deliberately carries no platform-compliance conclusions |

## Configuration

The templates in [`../templates/`](../templates/README.md) are the working configuration, with the reasoning written beside each value. Start with [`templates/README.md`](../templates/README.md) — in particular, read the section on where the credential actually comes from, because getting it wrong makes every hosted call fail with a 401 while the configuration looks correct.

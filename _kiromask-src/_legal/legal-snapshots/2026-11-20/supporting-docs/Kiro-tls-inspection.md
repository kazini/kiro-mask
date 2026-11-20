> ## Documentation Index
> Fetch the complete documentation index at: https://kiro.dev/llms.txt
> Use this file to discover all available pages before exploring further.

# TLS inspection compatibility

> Fix Kiro IDE connection resets on networks with TLS inspection by turning off post-quantum key exchange.

Starting with version 1.1.98, Kiro IDE uses post-quantum key exchange (`X25519MLKEM768`) for its connections to Kiro services. Some corporate firewalls and proxies that inspect TLS traffic reset these connections, so sign-in, chat, and other Kiro features stop working. Administrators can turn off post-quantum key exchange for Kiro IDE 1.4.51 and later.

## Check whether you are affected

You are likely affected if both of the following are true:

- Kiro IDE 1.1.70 works on your network, but later versions do not.
- The **Kiro Logs** output contains `read ECONNRESET`, for example `Unable to fetch account usage data: read ECONNRESET`. To open it, choose **View** > **Output** and select **Kiro Logs**.

If both are true, ask your administrator to deploy the setting below.

## Turn off post-quantum key exchange

**⚠️ Warning:** This removes post-quantum protection from Kiro IDE's connections. Use it only on networks that need it.

Administrators deploy this setting in the [managed settings file](https://kiro.dev/docs/enterprise/governance/permissions.md). Use your device management tool, for example Jamf, Group Policy, or another MDM solution, to deploy the file to each affected device:

```json
{
  "rules": [],
  "settings": {
    "tls_key_exchange": "classical"
  }
}
```

| Platform | File location                                             |
| -------- | --------------------------------------------------------- |
| macOS    | `/Library/Application Support/Kiro/managed-settings.json` |
| Windows  | `C:\ProgramData\Kiro\managed-settings.json`               |
| Linux    | `/etc/kiro/managed-settings.json`                         |

- If you already deploy the file for permission policies or sign-in controls, add the key to its `settings` object and keep the `rules` array.
- On Windows, create the `C:\ProgramData\Kiro` folder before deploying the file, and allow only Administrators and SYSTEM to write to it so users cannot change the setting. Deploy the file as UTF-8 without a byte order mark.
- For Remote SSH, WSL, and Dev Container windows, also deploy the file to the remote machine. For WSL, that means inside each distribution. See [remote development](https://kiro.dev/docs/ide/remote-development.md) for Remote SSH and Dev Containers setup.

The setting applies after users quit and reopen Kiro. To confirm it applied on a device, choose **Developer: Open Logs Folder** from the Command Palette and check that `exthost.log` contains `[TlsKeyExchange] Node.js TLS connections offer only X25519:P-256:P-384`.


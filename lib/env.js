import { execFileSync } from "node:child_process";

const WINDOWS_ENV_KEYS = [
  ["HKCU\\Environment", "Windows user environment"],
  ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "Windows system environment"],
];

/**
 * Resolve OPENAI_API_KEY. Prefers the process environment; on Windows it also checks
 * the persisted user/system environment, because terminals started before the variable
 * was set (e.g. inside an already-running editor) don't inherit it.
 * Never logs or returns anything but the key and a description of where it came from.
 */
export function resolveApiKey(env = process.env, platform = process.platform, run = execFileSync) {
  const fromEnv = env.OPENAI_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "process environment" };

  if (platform === "win32") {
    for (const [hive, label] of WINDOWS_ENV_KEYS) {
      try {
        const out = run("reg", ["query", hive, "/v", "OPENAI_API_KEY"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
        const match = /OPENAI_API_KEY\s+REG_(?:EXPAND_)?SZ\s+(\S.*)$/m.exec(out);
        if (match) return { key: match[1].trim(), source: label };
      } catch {
        // Value not present in this hive.
      }
    }
  }
  return { key: null, source: null };
}

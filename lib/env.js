import { execFileSync } from "node:child_process";

const WINDOWS_ENV_KEYS = [
  ["HKCU\\Environment", "Windows user environment"],
  ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "Windows system environment"],
];

/**
 * Resolve an environment variable. Prefers the process environment; on Windows it also checks
 * the persisted user/system environment, because terminals started before the variable
 * was set (e.g. inside an already-running editor) don't inherit it.
 * Never logs or returns anything but the value and a description of where it came from.
 */
export function resolveEnv(name, env = process.env, platform = process.platform, run = execFileSync) {
  const fromEnv = env[name]?.trim();
  if (fromEnv) return { value: fromEnv, source: "process environment" };

  if (platform === "win32") {
    const pattern = new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(\\S.*)$`, "m");
    for (const [hive, label] of WINDOWS_ENV_KEYS) {
      try {
        const out = run("reg", ["query", hive, "/v", name], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
        const match = pattern.exec(out);
        if (match) return { value: match[1].trim(), source: label };
      } catch {
        // Value not present in this hive.
      }
    }
  }
  return { value: null, source: null };
}

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const cwd = process.cwd();
const cleanupTargets = [
    path.join(cwd, 'android', 'app', 'src', 'main', 'assets', 'public'),
    path.join(cwd, 'android', 'capacitor-cordova-android-plugins')
];

const removeDirectoryWithFallback = (target) => {
    try {
        fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
        try {
            const escaped = target.replace(/'/g, "''");
            execSync(
                `powershell -NoProfile -Command "if (Test-Path -LiteralPath '${escaped}') { Remove-Item -LiteralPath '${escaped}' -Recurse -Force -ErrorAction SilentlyContinue }"`,
                { stdio: 'ignore' }
            );
        } catch {
            // continue to final fallback
        }

        try {
            execSync(`cmd /c if exist "${target}" rd /s /q "${target}"`, { stdio: 'ignore' });
        } catch {
            // ignored
        }

        if (fs.existsSync(target)) {
            console.warn(`[cap-prep] Failed to remove ${target}:`, error);
        }
    }
};

for (const target of cleanupTargets) {
    removeDirectoryWithFallback(target);
}

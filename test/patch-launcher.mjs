// Splice the "start the local inference server" step into the DSH launcher.
//
// Constraints that shape this script:
//
// 1. The launcher is UTF-8 **with** BOM and LF-only, and contains Chinese text.
//    It is written back with exactly that encoding, and the original text is
//    carried through untouched so only new lines are added.
// 2. The inserted Chinese must be written as real characters, NOT as "\uXXXX"
//    escapes: PowerShell has no such escape, so a backslash-u sequence would be
//    printed literally. The file's BOM is what makes real Chinese safe here.
// 3. This script itself is pure ASCII apart from the strings it deliberately
//    inserts, so Windows PowerShell 5.1 reading it as ANSI cannot corrupt it.
//    Every non-ASCII character in the inserted block is checked against an
//    explicit allow-list before anything is written.
//
// Idempotent: a launcher that already calls Start-LocalAi is left alone.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'

const target = process.argv[2] ?? 'C:\\Users\\\u543e\\OneDrive\\\u6587\u6863\\\u5343\u661f\u5947\u57df\\dsh-launcher.ps1'
const backup = target + '.bak-pre-localai'

// Real Chinese strings, written as escapes here so this file stays ASCII.
const warmup = '\u672C\u5730\u63A8\u7406\u670D\u52A1\u6B63\u5728\u540E\u53F0\u9884\u70ED' // 本地推理服务正在后台预热
const portWord = '\u7AEF\u53E3'                                                       // 端口
const ready = '\u5DF2\u5C31\u7EEA'                                                    // 已就绪
const starting = '\u6B63\u5728\u542F\u52A8'                                           // 正在启动
const failed = '\u542F\u52A8\u5931\u8D25\uFF0C\u8BE6\u89C1'                           // 启动失败，详见
const comma = '\u3001'                                                                 // 、

// Every non-ASCII code point permitted in the inserted block.
const ALLOWED = new Set(
  [...(warmup + portWord + ready + starting + failed + comma)].map((c) => c.codePointAt(0)),
)

const block = [
  '',
  '# ---- local inference server (token offload) -----------------------------',
  '# Started from here rather than from the Startup folder: the Startup folder',
  '# only runs at logon, and this machine had not rebooted since well before the',
  '# shortcut was installed, so the service was simply absent when needed. The',
  '# launcher runs on every DSH start, which is the reliable moment.',
  'function Test-LocalAiPort {',
  '    try {',
  '        $c = New-Object Net.Sockets.TcpClient',
  "        $c.Connect('127.0.0.1', 18080)",
  '        $c.Close()',
  '        return $true',
  '    } catch { return $false }',
  '}',
  '',
  'function Start-LocalAi {',
  '    if (Test-LocalAiPort) {',
  '        Write-Host "  [AI] " -NoNewline -ForegroundColor DarkGray',
  `        Write-Host "${warmup}${comma}${portWord} 18080 ${ready}" -ForegroundColor DarkGray`,
  '        return',
  '    }',
  "    $aiScript = 'F:\\bonsai\\start-local-ai.ps1'",
  '    if (-not (Test-Path $aiScript)) { return }',
  '    Write-Host "  [AI] " -NoNewline -ForegroundColor DarkGray',
  `    Write-Host "${warmup}${comma}${portWord} 18080 ${starting}..." -ForegroundColor DarkGray`,
  '',
  '    # Claim the start with a marker file before spawning. The plugin checks the',
  '    # same marker, so when both race to start the server only one actually',
  '    # spawns one. Without it a second llama-server binds nothing, stays alive,',
  '    # and wastes a full copy of the model in VRAM: measured 2 x 3.6GB of 8GB.',
  '    # A marker older than two minutes is from a dead process and is ignored.',
  "    $marker = Join-Path $env:TEMP 'dsh-local-ai.starting'",
  '    $claimed = $false',
  '    $fresh = $true',
  '    if (Test-Path $marker) {',
  '        try { $fresh = ((Get-Date) - (Get-Item $marker).LastWriteTime).TotalSeconds -lt 120 } catch { $fresh = $false }',
  '    }',
  '    if ($fresh) {',
  '        try { [System.IO.File]::WriteAllText($marker, "$PID", (New-Object System.Text.UTF8Encoding($false))); $claimed = $true } catch { $claimed = $false }',
  '    }',
  '',
  '    try {',
  "        $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $aiScript) -WindowStyle Hidden -PassThru",
  '    } catch {',
  `        Write-Host "       ${failed}: $aiScript" -ForegroundColor DarkYellow`,
  '        if ($claimed) { Remove-Item $marker -Force -ErrorAction SilentlyContinue }',
  '        return',
  '    }',
  '    # Same binary and same router arguments the plugin uses for its own start,',
  '    # so both paths serve the identical model list.',
  '    $serverExe = \'F:\\bonsai\\bin\\llama-official-vulkan\\llama-server.exe\'',
  '    $serverUp = $false',
  '    for ($i = 0; $i -lt 60; $i++) {',
  '        Start-Sleep -Milliseconds 500',
  '        if (Test-LocalAiPort) { $serverUp = $true; break }',
  '        if (-not (Get-Process llama-server -ErrorAction SilentlyContinue)) {',
  '            # Only the process that claimed the marker starts the binary',
  '            # directly, so two launchers cannot both fall back at once.',
  '            if ($claimed -and (Test-Path $serverExe)) {',
  "                $p = Start-Process -FilePath $serverExe -ArgumentList @('--models-dir', 'F:\\bonsai\\models', '--models-preset', 'F:\\bonsai\\models-preset.ini', '-ngl', '99', '-c', '32768', '--models-max', '1', '--host', '127.0.0.1', '--port', '18080', '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '-np', '1', '--jinja', '--reasoning-format', 'none') -WindowStyle Hidden -PassThru",
  '            }',
  '        }',
  '    }',
  '    if ($claimed) { Remove-Item $marker -Force -ErrorAction SilentlyContinue }',
  '    if ($serverUp) {',
  `        Write-Host "       ${portWord} 18080 ${ready}" -ForegroundColor DarkGray`,
  '    } else {',
  '        Write-Host "       still loading in the background (pid $($p.Id))" -ForegroundColor DarkGray',
  '    }',
  '}',
  '',
  '# Start the local model before DSH so the first delegation finds it warm.',
  'Start-LocalAi',
  '',
].join('\n')

// Guard: any non-ASCII in the block must be one of the strings we meant to add.
for (const ch of block) {
  const cp = ch.codePointAt(0)
  if (cp > 0x7f && !ALLOWED.has(cp)) {
    throw new Error(`unexpected non-ASCII U+${cp.toString(16)} in the inserted block; aborting`)
  }
}

const original = readFileSync(target, 'utf8')
if (original.includes('Start-LocalAi')) {
  console.log('launcher already contains Start-LocalAi; nothing to do')
  process.exit(0)
}

const anchor = 'if (Test-DshPort) {'
const at = original.indexOf(anchor)
if (at === -1) throw new Error('anchor "if (Test-DshPort) {" not found; refusing to guess an insertion point')
if ((original.match(/if \(Test-DshPort\) \{/g) ?? []).length !== 1) throw new Error('anchor is ambiguous; aborting')

const updated = original.slice(0, at) + block + original.slice(at)

if (!existsSync(backup)) {
  copyFileSync(target, backup)
  console.log(`backup written: ${backup}`)
}

const BOM = '\uFEFF'
const hadBom = original.startsWith(BOM)
writeFileSync(target, hadBom ? BOM + updated.slice(1) : updated, 'utf8')

// Verify what actually landed on disk, by reading the bytes back.
const bytes = readFileSync(target)
const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
const text = bytes.toString('utf8')
const crlf = (text.match(/\r\n/g) ?? []).length
console.log(`written: ${target}`)
console.log(`  BOM=${hasBom} (original had BOM=${hadBom})  CRLF=${crlf}  bytes=${bytes.length}`)
console.log(`  Start-LocalAi definitions/calls: ${(text.match(/Start-LocalAi/g) ?? []).length}`)
for (const [label, s] of [['warmup', warmup], ['ready', ready], ['starting', starting], ['failed', failed]]) {
  console.log(`  contains ${label.padEnd(9)}: ${text.includes(s)}`)
}
console.log(`  first line: ${text.split('\n')[0]}`)

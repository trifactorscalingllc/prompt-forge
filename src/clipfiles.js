'use strict';
// Files onto the system clipboard.
//
// A clipboard holds text or files, not both. The copied prompt names every attached file and says
// where it is; this is the second step, for a destination that takes pasted files (a chat window, a
// ticket, a mail): copy the prompt, paste it, then copy the files and paste them beside it. Each
// platform has exactly one way to do this without an extra install, and it is used as-is.

/** { bin, args, stdin } for the platform, or null where there is no built-in way. Pure. */
function clipboardCommand(paths, platform = process.platform) {
  const list = (Array.isArray(paths) ? paths : []).filter(Boolean);
  if (!list.length) return null;
  if (platform === 'win32') {
    // -LiteralPath: a file name with [brackets] must not be read as a wildcard.
    const quoted = list.map((p) => `'${String(p).replace(/'/g, "''")}'`).join(',');
    return { bin: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', '-'], stdin: `Set-Clipboard -LiteralPath ${quoted}\n` };
  }
  if (platform === 'darwin') {
    const script = [
      'ObjC.import("AppKit");',
      'var pb = $.NSPasteboard.generalPasteboard;',
      'pb.clearContents;',
      'var files = $.NSMutableArray.alloc.init;',
      `${JSON.stringify(list)}.forEach(function (p) { files.addObject($.NSURL.fileURLWithPath(p)); });`,
      'pb.writeObjects(files);',
    ].join('\n');
    return { bin: 'osascript', args: ['-l', 'JavaScript', '-e', script], stdin: null };
  }
  if (platform === 'linux') {
    const uris = list.map((p) => `file://${encodeURI(p)}`).join('\r\n');
    return { bin: 'xclip', args: ['-selection', 'clipboard', '-t', 'text/uri-list'], stdin: uris };
  }
  return null;
}

async function copyFiles(paths, { runCli, resolveBin = null, platform = process.platform }) {
  const cmd = clipboardCommand(paths, platform);
  if (!cmd) return { ok: false, error: `putting files on the clipboard is not supported on ${platform}` };
  const bin = platform === 'linux' && resolveBin ? resolveBin('xclip', {}) : cmd.bin;
  if (!bin) return { ok: false, error: 'xclip is not installed' };
  const r = await runCli({ bin, args: cmd.args, stdin: cmd.stdin, timeoutMs: 15000 });
  return r.ok ? { ok: true } : { ok: false, error: String(r.stderr || r.error || 'failed').trim().slice(0, 200) };
}

module.exports = { clipboardCommand, copyFiles };

export interface LineDiff {
  text: string;
  added: number;
  removed: number;
}

type Op = { kind: ' ' | '+' | '-'; line: string };

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // Guard against quadratic blow-up on very large inputs: fall back to "replace everything".
  if (n * m > 6_000_000) {
    return [...a.map((line): Op => ({ kind: '-', line })), ...b.map((line): Op => ({ kind: '+', line }))];
  }
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i]! });
      i++;
      j++;
    } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) {
      ops.push({ kind: '-', line: a[i++]! });
    } else {
      ops.push({ kind: '+', line: b[j++]! });
    }
  }
  while (i < n) ops.push({ kind: '-', line: a[i++]! });
  while (j < m) ops.push({ kind: '+', line: b[j++]! });
  return ops;
}

/** Unified line diff with `context` unchanged lines around each change. */
export function unifiedDiff(before: string, after: string, context = 3): LineDiff {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  const ops = lcsOps(a, b);
  const keep = new Array<boolean>(ops.length).fill(false);
  let added = 0;
  let removed = 0;
  ops.forEach((op, k) => {
    if (op.kind === ' ') return;
    if (op.kind === '+') added++;
    else removed++;
    for (let d = -context; d <= context; d++) {
      const idx = k + d;
      if (idx >= 0 && idx < ops.length) keep[idx] = true;
    }
  });
  const out: string[] = [];
  let aLine = 1;
  let bLine = 1;
  let inHunk = false;
  ops.forEach((op, k) => {
    if (keep[k]) {
      if (!inHunk) {
        out.push(`@@ -${aLine} +${bLine} @@`);
        inHunk = true;
      }
      out.push(`${op.kind}${op.line}`);
    } else {
      inHunk = false;
    }
    if (op.kind !== '+') aLine++;
    if (op.kind !== '-') bLine++;
  });
  return { text: out.join('\n'), added, removed };
}

/**
 * A minimal one-page PDF without content. Written by hand so inserting a blank
 * page does not need to load pdf-lib.
 */
export function makeBlankPdf(width: number, height: number): Uint8Array {
  const round = (n: number) => Math.round(n * 100) / 100;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${round(width)} ${round(height)}] /Resources << >> /Contents 4 0 R >>`,
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

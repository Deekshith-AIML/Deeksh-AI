import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { Document } from 'docx';
import { Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell } from 'docx';
import { extractDocument } from '../src/services/documents/extraction/index.js';
import { getDocumentsConfig } from '../src/config/documents.config.js';

const config = getDocumentsConfig();

describe('M5 Phase 3 extraction integration', () => {
  it('extracts PDF text with page tracking', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    page.drawText('Hello world from page one. This is a longer text to exceed the fifty character minimum threshold.');
    const bytes = await pdf.save();
    const buf = Buffer.from(bytes);
    const result = await extractDocument(buf, 'pdf', config);
    expect(result.hasExtractableText).toBe(true);
    expect(result.totalPages).toBe(1);
    expect(result.totalText).toContain('Hello world');
    expect(result.paragraphs.length).toBeGreaterThan(0);
    expect(result.paragraphs[0]!.provenance.pageStart).toBe(1);
  });

  it('extracts multi-page PDF', async () => {
    const pdf = await PDFDocument.create();
    const p1 = pdf.addPage();
    p1.drawText('Page one content with enough characters to exceed the minimum threshold for extraction.');
    const p2 = pdf.addPage();
    p2.drawText('Page two content with enough characters to exceed the minimum threshold for extraction.');
    const bytes = await pdf.save();
    const buf = Buffer.from(bytes);
    const result = await extractDocument(buf, 'pdf', config);
    expect(result.hasExtractableText).toBe(true);
    expect(result.totalPages).toBe(2);
    expect(result.totalText).toContain('Page one');
    expect(result.totalText).toContain('Page two');
  });

  it('extracts DOCX paragraphs and headings', async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: 'Heading One', heading: HeadingLevel.HEADING_1 }),
            new Paragraph({ text: 'This is a paragraph.' }),
            new Paragraph({ text: 'Heading Two', heading: HeadingLevel.HEADING_2 }),
            new Paragraph({ text: 'Another paragraph.' }),
          ],
        },
      ],
    });
    const buf = await Packer.toBuffer(doc);
    const result = await extractDocument(buf, 'docx', config);
    expect(result.hasExtractableText).toBe(true);
    expect(result.totalText).toContain('Heading One');
    expect(result.totalText).toContain('This is a paragraph.');
    expect(result.paragraphs.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts DOCX tables', async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Table({
              rows: [
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph({ text: 'Cell A1' })] }),
                    new TableCell({ children: [new Paragraph({ text: 'Cell A2' })] }),
                  ],
                }),
              ],
            }),
            new Paragraph({ text: 'After table.' }),
          ],
        },
      ],
    });
    const buf = await Packer.toBuffer(doc);
    const result = await extractDocument(buf, 'docx', config);
    expect(result.hasExtractableText).toBe(true);
    expect(result.totalText).toContain('After table.');
  });

  it('extracts TXT UTF-8', async () => {
    const text = 'Hello world\n\nSecond paragraph with unicode: café\n\nThird.';
    const buf = Buffer.from(text, 'utf-8');
    const result = await extractDocument(buf, 'txt', config);
    expect(result.hasExtractableText).toBe(true);
    expect(result.paragraphs.length).toBe(3);
    expect(result.totalText).toContain('café');
  });

  it('extracts TXT UTF-16LE with BOM', async () => {
    const text = 'Hello UTF-16LE\n\nSecond para.';
    const buf = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(text, 'utf16le'),
    ]);
    const result = await extractDocument(buf, 'txt', config);
    expect(result.hasExtractableText).toBe(true);
    expect(result.totalText).toContain('Hello UTF-16LE');
  });

  it('extracts TXT UTF-16BE with BOM', async () => {
    const text = 'Hello UTF-16BE\n\nSecond para.';
    // Encode manually as UTF-16BE.
    const utf16be = Buffer.alloc(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      utf16be[i * 2] = (code >> 8) & 0xff;
      utf16be[i * 2 + 1] = code & 0xff;
    }
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be]);
    const result = await extractDocument(buf, 'txt', config);
    expect(result.hasExtractableText).toBe(true);
    expect(result.totalText).toContain('Hello UTF-16BE');
  });

  it('handles empty TXT', async () => {
    const buf = Buffer.from('', 'utf-8');
    const result = await extractDocument(buf, 'txt', config);
    expect(result.hasExtractableText).toBe(false);
    expect(result.paragraphs.length).toBe(0);
  });

  it('handles whitespace-only TXT', async () => {
    const buf = Buffer.from('   \n\n   \n', 'utf-8');
    const result = await extractDocument(buf, 'txt', config);
    expect(result.hasExtractableText).toBe(false);
  });

  it('detects binary content in TXT', async () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f]);
    const result = await extractDocument(buf, 'txt', config);
    expect(result.hasExtractableText).toBe(false);
  });

  it('rejects malformed PDF', async () => {
    const buf = Buffer.from('not a pdf at all');
    await expect(extractDocument(buf, 'pdf', config)).rejects.toThrow();
  });

  it('rejects malformed DOCX', async () => {
    const buf = Buffer.from('not a docx');
    await expect(extractDocument(buf, 'docx', config)).rejects.toThrow();
  });
});

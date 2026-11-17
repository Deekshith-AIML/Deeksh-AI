import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { Document } from 'docx';
import { Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell } from 'docx';
import { extractDocument } from '../src/services/documents/extraction/index.js';
import { getDocumentsConfig } from '../src/config/documents.config.js';

const config = getDocumentsConfig();

/** Find an extracted paragraph by unique text, failing clearly if absent. */
function requireParagraph(
  result: Awaited<ReturnType<typeof extractDocument>>,
  needle: string,
): (typeof result.paragraphs)[number] {
  const paragraph = result.paragraphs.find((entry) => entry.text.includes(needle));
  if (!paragraph) {
    throw new Error(`Expected an extracted paragraph containing "${needle}"`);
  }
  return paragraph;
}

describe('M5 Phase 3 extraction integration', () => {
  it('extracts PDF text with page tracking', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    page.drawText(
      'Hello world from page one. This is a longer text to exceed the fifty character minimum threshold.',
      { x: 50, y: 700, size: 12 },
    );
    const bytes = await pdf.save();
    const buf = Buffer.from(bytes);
    const result = await extractDocument(buf, 'pdf', config);
    expect(result.hasExtractableText).toBe(true);
    expect(result.totalPages).toBe(1);
    expect(result.totalText).toContain('Hello world');
    expect(result.paragraphs.length).toBeGreaterThan(0);
    const paragraph = requireParagraph(result, 'Hello world');
    expect(paragraph.provenance.pageStart).toBe(1);
    expect(paragraph.provenance.pageEnd).toBe(1);
  });

  it('preserves actual page provenance for a multi-page PDF', async () => {
    const pdf = await PDFDocument.create();

    const pageOne = pdf.addPage();
    pageOne.drawText('PROJECT INTRODUCTION', { x: 50, y: 700, size: 12 });
    pageOne.drawText(
      'This page describes the goals and scope of the project in enough detail for extraction.',
      { x: 50, y: 660, size: 12 },
    );

    const pageTwo = pdf.addPage();
    pageTwo.drawText('TECHNICAL REQUIREMENTS', { x: 50, y: 700, size: 12 });
    pageTwo.drawText(
      'This page lists the technical requirements and constraints for the implementation.',
      { x: 50, y: 660, size: 12 },
    );

    const bytes = await pdf.save();
    const result = await extractDocument(Buffer.from(bytes), 'pdf', config);

    expect(result.hasExtractableText).toBe(true);
    expect(result.totalPages).toBe(2);

    const introduction = requireParagraph(result, 'PROJECT INTRODUCTION');
    const requirements = requireParagraph(result, 'TECHNICAL REQUIREMENTS');

    // Real page numbers, never hardcoded to page 1.
    expect(introduction.provenance.pageStart).toBe(1);
    expect(introduction.provenance.pageEnd).toBe(1);
    expect(requirements.provenance.pageStart).toBe(2);
    expect(requirements.provenance.pageEnd).toBe(2);

    // A citation for page-2 content can never resolve to page 1.
    expect(requirements.provenance.pageStart).not.toBe(1);

    // Document order is preserved in both the paragraph list and totalText.
    const introductionIndex = result.paragraphs.indexOf(introduction);
    const requirementsIndex = result.paragraphs.indexOf(requirements);
    expect(introductionIndex).toBeLessThan(requirementsIndex);
    expect(result.totalText.indexOf('PROJECT INTRODUCTION')).toBeLessThan(
      result.totalText.indexOf('TECHNICAL REQUIREMENTS'),
    );

    // Body paragraphs inherit the page they were extracted from.
    expect(requireParagraph(result, 'goals and scope').provenance.pageStart).toBe(1);
    expect(requireParagraph(result, 'technical requirements and constraints').provenance.pageStart).toBe(2);
  });

  it('keeps page ranges for paragraphs that continue across pages', async () => {
    const pdf = await PDFDocument.create();

    const pageOne = pdf.addPage();
    pageOne.drawText(
      'This paragraph starts on page one and continues',
      { x: 50, y: 700, size: 12 },
    );

    const pageTwo = pdf.addPage();
    pageTwo.drawText(
      'directly onto page two with additional explanation.',
      { x: 50, y: 700, size: 12 },
    );

    const bytes = await pdf.save();
    const result = await extractDocument(Buffer.from(bytes), 'pdf', config);

    expect(result.hasExtractableText).toBe(true);
    expect(result.totalPages).toBe(2);

    const continued = requireParagraph(result, 'starts on page one');
    expect(continued.text).toContain('continues directly onto page two');
    expect(continued.provenance.pageStart).toBe(1);
    expect(continued.provenance.pageEnd).toBe(2);

    // The continuation was stitched, not emitted as a separate page-2 paragraph.
    expect(result.paragraphs.filter((p) => p.text.includes('directly onto page two'))).toHaveLength(1);
  });

  it('handles empty PDF pages without inventing provenance', async () => {
    const pdf = await PDFDocument.create();

    const pageOne = pdf.addPage();
    pageOne.drawText(
      'Content on the first page that is long enough to pass the extraction threshold.',
      { x: 50, y: 700, size: 12 },
    );

    pdf.addPage(); // Deliberately empty page 2.

    const pageThree = pdf.addPage();
    pageThree.drawText(
      'Content on the third page that must be attributed to page three, not page two.',
      { x: 50, y: 700, size: 12 },
    );

    const bytes = await pdf.save();
    const result = await extractDocument(Buffer.from(bytes), 'pdf', config);

    expect(result.hasExtractableText).toBe(true);
    expect(result.totalPages).toBe(3);
    expect(result.metadata.pages_with_text).toBe(2);

    expect(requireParagraph(result, 'Content on the first page').provenance.pageStart).toBe(1);
    expect(requireParagraph(result, 'Content on the third page').provenance.pageStart).toBe(3);
    expect(requireParagraph(result, 'Content on the third page').provenance.pageEnd).toBe(3);
    expect(result.paragraphs.some((p) => p.provenance.pageStart === 2)).toBe(false);
  });


  it('extracts DOCX heading hierarchy and section provenance', async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: 'Project Plan', heading: HeadingLevel.HEADING_1 }),
            new Paragraph({ text: 'Overview paragraph.' }),
            new Paragraph({ text: 'Goals', heading: HeadingLevel.HEADING_2 }),
            new Paragraph({ text: 'Goal paragraph.' }),
            new Paragraph({ text: 'Metrics', heading: HeadingLevel.HEADING_3 }),
            new Paragraph({ text: 'Metric paragraph.' }),
            new Paragraph({ text: 'Risks', heading: HeadingLevel.HEADING_2 }),
            new Paragraph({ text: 'Risk paragraph.' }),
          ],
        },
      ],
    });
    const buf = await Packer.toBuffer(doc);
    const result = await extractDocument(buf, 'docx', config);

    expect(result.hasExtractableText).toBe(true);
    expect(result.totalPages).toBeNull(); // DOCX pages are never invented.

    const headings = result.paragraphs.filter((p) => p.provenance.blockType === 'heading');
    expect(headings.map((p) => p.text)).toEqual([
      'Project Plan',
      'Goals',
      'Metrics',
      'Risks',
    ]);
    expect(headings.map((p) => p.provenance.headingLevel)).toEqual([1, 2, 3, 2]);
    expect(headings.map((p) => p.provenance.sectionPath)).toEqual([
      'Project Plan',
      'Project Plan > Goals',
      'Project Plan > Goals > Metrics',
      'Project Plan > Risks',
    ]);

    // Body blocks inherit the nearest heading and full section path.
    const overview = requireParagraph(result, 'Overview paragraph.');
    expect(overview.provenance.blockType).toBe('paragraph');
    expect(overview.provenance.heading).toBe('Project Plan');
    expect(overview.provenance.sectionPath).toBe('Project Plan');

    const metric = requireParagraph(result, 'Metric paragraph.');
    expect(metric.provenance.heading).toBe('Metrics');
    expect(metric.provenance.sectionPath).toBe('Project Plan > Goals > Metrics');

    // Every DOCX block carries null page provenance.
    expect(
      result.paragraphs.every(
        (p) => p.provenance.pageStart === null && p.provenance.pageEnd === null,
      ),
    ).toBe(true);

    // Document order is preserved.
    const order = result.paragraphs.map((p) => p.text);
    expect(order.indexOf('Goals')).toBeLessThan(order.indexOf('Goal paragraph.'));
    expect(order.indexOf('Goal paragraph.')).toBeLessThan(order.indexOf('Metrics'));
    expect(order.indexOf('Metric paragraph.')).toBeLessThan(order.indexOf('Risks'));
  });

  it('extracts DOCX tables with rows, cells, and multiple tables', async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: 'Results', heading: HeadingLevel.HEADING_1 }),
            new Table({
              rows: [
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph({ text: 'Cell A1' })] }),
                    new TableCell({ children: [new Paragraph({ text: 'Cell A2' })] }),
                  ],
                }),
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph({ text: 'Cell B1' })] }),
                    new TableCell({ children: [new Paragraph({ text: 'Cell B2' })] }),
                  ],
                }),
              ],
            }),
            new Paragraph({ text: 'Between tables.' }),
            new Table({
              rows: [
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph({ text: 'Second C1' })] }),
                    new TableCell({ children: [new Paragraph({ text: 'Second C2' })] }),
                  ],
                }),
              ],
            }),
            new Paragraph({ text: 'After tables.' }),
          ],
        },
      ],
    });
    const buf = await Packer.toBuffer(doc);
    const result = await extractDocument(buf, 'docx', config);

    expect(result.hasExtractableText).toBe(true);
    expect(result.metadata.tables).toBe(2);

    const rows = result.paragraphs.filter((p) => p.provenance.blockType === 'table-row');
    expect(rows.map((p) => p.text)).toEqual([
      'Cell A1 | Cell A2',
      'Cell B1 | Cell B2',
      'Second C1 | Second C2',
    ]);
    expect(rows.map((p) => p.provenance.tableIndex)).toEqual([0, 0, 1]);
    expect(rows.map((p) => p.provenance.tableRowIndex)).toEqual([0, 1, 0]);

    // Table rows keep the enclosing section.
    expect(rows[0]?.provenance.heading).toBe('Results');

    // Ordering across paragraphs and tables is preserved.
    const order = result.paragraphs.map((p) => p.text);
    expect(order.indexOf('Cell B2')).toBe(-1);
    expect(order.indexOf('Cell B1 | Cell B2')).toBeLessThan(order.indexOf('Between tables.'));
    expect(order.indexOf('Between tables.')).toBeLessThan(
      order.indexOf('Second C1 | Second C2'),
    );
    expect(order.indexOf('Second C1 | Second C2')).toBeLessThan(order.indexOf('After tables.'));
  });

  it('extracts DOCX list items with section provenance', async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: 'Steps', heading: HeadingLevel.HEADING_1 }),
            new Paragraph({ text: 'First step', bullet: { level: 0 } }),
            new Paragraph({ text: 'Second step', bullet: { level: 0 } }),
          ],
        },
      ],
    });
    const buf = await Packer.toBuffer(doc);
    const result = await extractDocument(buf, 'docx', config);

    const items = result.paragraphs.filter(
      (p) => p.provenance.blockType === 'list-item',
    );
    expect(items.map((p) => p.text)).toEqual(['First step', 'Second step']);
    expect(items[0]?.provenance.heading).toBe('Steps');
    expect(items[0]?.provenance.sectionPath).toBe('Steps');
  });

  it('handles DOCX empty sections without inventing content', async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: 'Empty Chapter', heading: HeadingLevel.HEADING_1 }),
            // No body content for this heading.
            new Paragraph({ text: 'Next Chapter', heading: HeadingLevel.HEADING_1 }),
            new Paragraph({ text: 'Only paragraph.' }),
          ],
        },
      ],
    });
    const buf = await Packer.toBuffer(doc);
    const result = await extractDocument(buf, 'docx', config);

    const empty = requireParagraph(result, 'Empty Chapter');
    const next = requireParagraph(result, 'Next Chapter');
    const body = requireParagraph(result, 'Only paragraph.');

    expect(empty.provenance.sectionPath).toBe('Empty Chapter');
    expect(next.provenance.sectionPath).toBe('Next Chapter');
    expect(body.provenance.sectionPath).toBe('Next Chapter');

    // Nothing was fabricated for the empty section.
    const emptyIndex = result.paragraphs.indexOf(empty);
    const nextIndex = result.paragraphs.indexOf(next);
    expect(nextIndex).toBe(emptyIndex + 1);
  });

  it('rejects a malformed DOCX package', async () => {
    const buf = Buffer.from('not a docx at all');
    await expect(extractDocument(buf, 'docx', config)).rejects.toMatchObject({
      code: 'MALFORMED_FILE',
    });
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

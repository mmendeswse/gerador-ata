/**
 * Gerador de DOCX sem dependências.
 *
 * Um arquivo .docx é um ZIP com XML dentro. Este módulo monta o XML
 * (WordprocessingML) a partir dos blocos do documento e empacota em um ZIP
 * sem compressão (método "store"), o que dispensa qualquer biblioteca externa
 * e funciona 100% no navegador.
 */

import { parseDocument, splitMarks } from '../lib/docmodel.js';

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

function escapeXml(value) {
  return String(value ?? '')
    // caracteres de controle não são permitidos em XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function run(text, { bold = false, italic = false, size = null, highlight = false, color = null } = {}) {
  if (!text) return '';
  const props = [
    bold ? '<w:b/><w:bCs/>' : '',
    italic ? '<w:i/><w:iCs/>' : '',
    color ? `<w:color w:val="${color}"/>` : '',
    size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : '',
    highlight ? '<w:highlight w:val="yellow"/>' : '',
  ].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

/** Texto com os trechos entre colchetes realçados em amarelo (pontos a conferir). */
function markedRuns(text, options = {}) {
  return splitMarks(text)
    .map((piece) => run(piece.text, { ...options, highlight: piece.mark }))
    .join('');
}

function paragraph(content, { align = 'both', before = 0, after = 160, keepNext = false } = {}) {
  return (
    '<w:p><w:pPr>' +
    (keepNext ? '<w:keepNext/>' : '') +
    `<w:spacing w:before="${before}" w:after="${after}"/>` +
    `<w:jc w:val="${align}"/>` +
    `</w:pPr>${content}</w:p>`
  );
}

function blockToXml(block) {
  switch (block.type) {
    case 'title':
      return paragraph(markedRuns(block.text, { bold: true, size: 26 }), { align: 'center', after: 320 });
    case 'meta':
      return paragraph(run(`${block.label} `, { bold: true }) + markedRuns(block.text), { align: 'left', after: 60 });
    case 'heading':
      return paragraph(markedRuns(block.text, { bold: true }), { align: 'left', before: 360, after: 200, keepNext: true });
    case 'subheading':
      return paragraph(markedRuns(block.text, { bold: true }), { align: 'left', before: 240, after: 120, keepNext: true });
    case 'deliberation':
    case 'president':
      return paragraph(run(`${block.label} `, { bold: true }) + markedRuns(block.text));
    case 'note':
      return paragraph(run(block.text, { italic: true, size: 20, color: '666666' }), { align: 'left', before: 240 });
    default:
      return paragraph(markedRuns(block.text));
  }
}

function documentXml(blocks) {
  let firstBodyAfterMeta = true;
  const body = blocks
    .map((block, index) => {
      // Espaço entre o bloco de metadados (Data/Local/Membros) e o corpo.
      const previous = blocks[index - 1];
      if (previous?.type === 'meta' && block.type === 'paragraph' && firstBodyAfterMeta) {
        firstBodyAfterMeta = false;
        return paragraph(markedRuns(block.text), { before: 240 });
      }
      return blockToXml(block);
    })
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1701" w:right="1134" w:bottom="1134" w:left="1701" w:header="709" w:footer="709" w:gutter="0"/>' +
    '</w:sectPr></w:body></w:document>'
  );
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults>' +
  '<w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/>' +
  '<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="pt-BR" w:eastAsia="pt-BR" w:bidi="ar-SA"/>' +
  '</w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="340" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  '</w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '</w:styles>';

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '</Types>';

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '</Relationships>';

const DOCUMENT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

function corePropsXml(title) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    '<dc:creator>Gerador de Ata e Momento Aberto</dc:creator>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

// ---------------------------------------------------------------------------
// ZIP (método "store", sem compressão)
// ---------------------------------------------------------------------------

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const encoder = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // versão necessária
    local.setUint16(6, 0x0800, true); // nomes em UTF-8
    local.setUint16(8, 0, true); // método: store
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, dosTime, true);
    entry.setUint16(14, dosDate, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint16(30, 0, true); // extra
    entry.setUint16(32, 0, true); // comentário
    entry.setUint16(34, 0, true); // disco
    entry.setUint16(36, 0, true); // atributos internos
    entry.setUint32(38, 0, true); // atributos externos
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

/**
 * @param {string} text  texto do documento (exatamente como está no editor)
 * @param {{ title?: string }} [options]
 * @returns {Blob} arquivo .docx
 */
export function buildDocx(text, { title = 'Documento' } = {}) {
  const blocks = parseDocument(text);
  return zipStore([
    { name: '[Content_Types].xml', content: CONTENT_TYPES_XML },
    { name: '_rels/.rels', content: ROOT_RELS_XML },
    { name: 'docProps/core.xml', content: corePropsXml(title) },
    { name: 'word/document.xml', content: documentXml(blocks) },
    { name: 'word/styles.xml', content: STYLES_XML },
    { name: 'word/_rels/document.xml.rels', content: DOCUMENT_RELS_XML },
  ]);
}

/* Private, append-only evidence uploads. Shared by staff and the restricted carrier page. */
'use strict';
const CargoDocuments = (() => {
  const bucket = 'cargo-order-documents';
  const categories = { cmr: 'Signert CMR / fraktbrev', pod: 'Leveringskvittering', photo: 'Bilder', temperature: 'Temperaturdokumentasjon', other: 'Annet dokument' };
  async function digest(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join(''); }
  function fileType(bytes) {
    const b = new Uint8Array(bytes), text = new TextDecoder('ascii').decode(b.slice(0, 12));
    if (text.startsWith('%PDF-')) return 'application/pdf';
    if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
    if ([137,80,78,71,13,10,26,10].every((n, i) => b[i] === n)) return 'image/png';
    if (text.startsWith('RIFF') && text.slice(8,12) === 'WEBP') return 'image/webp';
    throw new Error('Velg en PDF, JPG, PNG eller WebP-fil. HEIC-bilder må eksporteres som JPG først.');
  }
  async function finish(client, id) {
    const result = await client.from('order_documents').update({ status: 'ready' }).eq('id', id).select('*').single();
    if (result.error) throw result.error;
    return result.data;
  }
  async function upload(client, orderId, file, category) {
    if (!file || file.size < 1 || file.size > 20 * 1024 * 1024) throw new Error('Velg en fil på høyst 20 MB.');
    if (!Object.hasOwn(categories, category)) throw new Error('Velg dokumenttype.');
    const bytes = await file.arrayBuffer(), mime = fileType(bytes), id = crypto.randomUUID();
    const extension = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[mime];
    const filename = String(file.name || 'dokument').replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/\.[^.]*$/, '').slice(0,230) + extension;
    const metadata = { id, order_id: orderId, category, filename, storage_path: orderId + '/' + id,
      mime_type: mime, byte_size: bytes.byteLength, sha256: await digest(bytes) };
    const created = await client.from('order_documents').insert(metadata).select('id').single();
    if (created.error) throw created.error;
    const result = await client.storage.from(bucket).upload(metadata.storage_path, bytes, { upsert: false, contentType: mime, cacheControl: '0' });
    if (result.error) throw new Error('Opplastingen er ikke fullført: ' + result.error.message + '. Last opp på nytt; en ufullført registrering beholdes i historikken.');
    try { return await finish(client, id); }
    catch (error) { throw new Error('Filen er overført, men ikke ferdig registrert. Bruk «Fullfør registrering» på dokumentet. ' + error.message); }
  }
  async function download(client, document) {
    const result = await client.storage.from(bucket).download(document.storage_path);
    if (result.error) throw result.error;
    const bytes = await result.data.arrayBuffer();
    if (bytes.byteLength !== Number(document.byte_size) || await digest(bytes) !== document.sha256) throw new Error('Filkontrollen feilet. Dokumentet er ikke lastet ned. Kontakt administrator.');
    const url = URL.createObjectURL(new Blob([bytes], { type: document.mime_type }));
    const a = window.document.createElement('a'); a.href = url; a.download = document.filename; a.rel = 'noopener';
    window.document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  return { categories, digest, fileType, upload, finish, download };
})();

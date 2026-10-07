revoke delete on public.orders from authenticated;
alter table public.order_documents add constraint cargo_document_safe_filename check(filename !~ '[[:cntrl:]]' and position('/' in filename)=0 and position(chr(92) in filename)=0 and ((mime_type='application/pdf' and right(lower(filename),4)='.pdf') or(mime_type='image/jpeg' and(right(lower(filename),4)='.jpg' or right(lower(filename),5)='.jpeg')) or(mime_type='image/png' and right(lower(filename),4)='.png') or(mime_type='image/webp' and right(lower(filename),5)='.webp')));
notify pgrst,'reload schema';

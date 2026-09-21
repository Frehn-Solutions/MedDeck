-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Creates a private bucket for study materials where each user can only
-- see, upload and delete files inside their own folder (<user id>/...).

-- 1. The bucket. `public = false` means files are only reachable with a signed-in user's access,
-- never by a plain URL. Storage itself enforces the size limit and allowed file types.
-- The list must include every type in TYPES in public/js/storage.js. It also allows Word, PowerPoint and
-- image types ahead of the app supporting them, so enabling those later needs no change here.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'study-materials',
  'study-materials',
  false,
  26214400, -- 25 MB per file
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/markdown',
    'image/png',
    'image/jpeg'
  ]
)
-- If the bucket already exists, update its settings instead of failing, so this script can be re-run safely.
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- 2. Access rules (Row Level Security policies). Each one lets a signed-in user act only on files whose
-- first folder name equals their own user id, e.g. "<user id>/12345-notes.pdf".
-- Dropping first makes the script re-runnable, since a policy name can only exist once.
drop policy if exists "Users read own study materials" on storage.objects;
drop policy if exists "Users upload own study materials" on storage.objects;
drop policy if exists "Users delete own study materials" on storage.objects;

-- Read (also needed for listing files and creating download links)
create policy "Users read own study materials"
on storage.objects for select to authenticated
using (bucket_id = 'study-materials' and (storage.foldername(name))[1] = auth.uid()::text);

-- Upload (`with check` validates the new file's path before it is stored)
create policy "Users upload own study materials"
on storage.objects for insert to authenticated
with check (bucket_id = 'study-materials' and (storage.foldername(name))[1] = auth.uid()::text);

-- Delete (used when an upload can't be recorded and the file must be removed again)
create policy "Users delete own study materials"
on storage.objects for delete to authenticated
using (bucket_id = 'study-materials' and (storage.foldername(name))[1] = auth.uid()::text);

# Background publishing

[Documentation](README.md) / [Project overview](../README.md)

- [Publisher](#publisher)
  - [Moving an existing caller onto the generic contract](#moving-an-existing-caller-onto-the-generic-contract)

## Publisher

**It knows nothing about your backend, on purpose.** The upload runs in a process your JavaScript is
not in, hours after `publish()` returned, so there is nobody for it to ask. Everything it needs is
DATA it was handed and wrote down: the URLs, the HTTP method, the multipart field names, the dotted
path its id lives at in your response, and the body to finish with. If a thing cannot be written
down it cannot be used here, which is why there are no callbacks anywhere in this contract.

**Two upload shapes.** `POST` builds the multipart form your `fields` and `fileField` describe -
that is where a server convention like Fine Uploader's `qquuid`/`qqfile` goes. `PUT` sends the file
as the raw body with no envelope, which is what a presigned S3, R2, GCS or Azure URL wants; there
each file carries its own signed `url`.

**The caller's JSON stays the caller's.** `bodyTemplate` is the complete finalize body with
`"$ID:<uploadId>"`, `"$IDS:<tag>"` and `"$IDS"` where ids will go, replaced textually. The plugin
never has to understand your schema - which matters for something that may run from a persisted
record days later. Plain string replacement, never a regex: the body carries customer-written text
and a `$` in it must stay a `$`. An id keeps the JSON type your server used, so a numeric id goes
back as a number and a key goes back quoted.

**Nothing is uploaded twice.** An id survives cancels and retries, and a file that was mid-flight
when the process died is looked up first, if you gave a `lookupUrlTemplate`. `publish()` on a batch
already in flight is a no-op; the finalize step is idempotent on the record being `done`.

**Two workers, not one**, so a 503 on the finalize call retries only the finalize call.

**Retryable and not-retryable are different answers.** A network drop backs off silently (the caller
shows "waiting for connection"); a 401 stops at once and is retryable only once a fresh token
arrives; a 400 or a missing file is final. A server that reports failure in the body of a 200 is
caught only if you name the field, through `finalize.requirePath` - guessing would be worse.

**Progress is bytes, not files**, capped at 95 until the finalize call has answered.

### Moving an existing caller onto the generic contract

Everything the publisher used to assume about one particular backend is now something you pass. The
shape below is the old hard-coded behaviour, written out:

```ts
await BackgroundPublisher.publish({
  batchId,                                  // was pendingPostId
  headers: { 'X-Token': token },
  upload: {
    url: `${api}/api/download/asyncUpload`, // was uploadUrl
    method: 'POST',
    fileField: 'qqfile',                    // was hard-coded
    fields: { qquuid: '{uploadId}', qqfilename: '{fileName}' },  // were hard-coded
    idPath: 'downloadId',                   // was hard-coded
    lookupUrlTemplate: `${api}/api/download/byName/{uploadId}`,  // was {uploadGuid}
  },
  uploads: [
    { uploadId: mainGuid, tag: 'stitched', path: mainPath, mimeType: 'video/mp4',
      fields: { pictureId: String(pictureId) } },   // pictureId was a first-class field
    { uploadId: clipGuid, tag: 'original', path: clipPath, mimeType: 'video/mp4' },
  ],
  finalize: {                               // was createPost
    url: `${api}/api/Post/CreateContentPost`,
    bodyTemplate: JSON.stringify({ video: `$ID:${mainGuid}`, clips: '$IDS:original' }),
    requirePath: 'postId',                  // was an unconditional check
  },
});
```

| Was | Is |
|---|---|
| `pendingPostId` | `batchId`, everywhere including the composer |
| `uploadGuid` | `uploadId` |
| `role: 'stitched' \| 'original'` | `tag: string`, any value, never interpreted |
| `pictureId` | one entry in that upload's `fields` |
| `downloadId` on the state | `remoteId`, a string or a number |
| `postId` / `published` on the state and the finished event | `result`, your response parsed |
| `"$STITCHED"` | `"$ID:<uploadId>"` |
| `"$ORIGINALS"` | `"$IDS:<tag>"` |
| `"$ALL"` | `"$IDS"` |
| phase `creating` | phase `finalizing` |

Three behaviour changes to read carefully:

- **The stitched fallback is gone.** The old code treated the first upload as the post's video when
  nothing carried `role: 'stitched'`. Nothing is implicit now: name the upload you mean with
  `"$ID:<uploadId>"`. That policy was always the app's, and it is now written where the app can see it.
- **A 2xx is success unless you say otherwise.** The old code failed a create whose body had no
  `postId`. Set `finalize.requirePath` to keep that check.
- **Records written by the old version are dropped on upgrade.** They name fields that no longer
  exist, so a batch in flight when the new build lands is re-queued by your app rather than resumed.
  Same for the iOS background session id and the Android notification channel, both renamed: finish
  or cancel what is in flight before shipping the upgrade if that matters to you.

# koishi-plugin-w-message-db

[![npm](https://img.shields.io/npm/v/koishi-plugin-w-message-db?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-w-message-db)

WillBot: Message Database

## Service API

Other plugins can use the injected `messageDb` service to reference canonical
messages without duplicating their content or transferred assets:

- `captureMessage(session)` waits for persistence and returns the saved message.
- `getMessagesByKeys(keys)` and `getWordsByMessageKeys(keys)` hydrate records in
  key order.
- `retainMessages(owner, keys)` and `releaseMessages(owner, keys)` protect
  referenced messages from garbage collection.

## RoadMap

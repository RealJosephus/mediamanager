import test from 'node:test';
import { runLocalXmlFailurePipeline } from './local-xml-pipeline-fixture.js';

test('actual PostgreSQL update pipeline and actual local and WebDAV XML destination consumers', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE,
}, t => runLocalXmlFailurePipeline(t, ['local', 'webdav']));

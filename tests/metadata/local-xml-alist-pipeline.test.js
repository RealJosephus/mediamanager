import test from 'node:test';
import { runLocalXmlFailurePipeline } from './local-xml-pipeline-fixture.js';
import { startActualAList } from '../storage/helpers/actual-alist.js';

test('actual PostgreSQL update pipeline and actual AList XML destination consumer', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES || !process.env.MEDIAMANAGER_WEBDAV_EXECUTABLE
    || !process.env.MEDIAMANAGER_ALIST_EXECUTABLE,
}, t => runLocalXmlFailurePipeline(t, ['alist'], startActualAList));

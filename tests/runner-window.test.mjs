import assert from 'node:assert/strict';
import test from 'node:test';
import {showRunnerWorkbench} from '../scripts/show-runner-workbench.mjs';

const url = 'http://127.0.0.1:5173/automation';
function fixture(windowState, targetUrl = url) {
  const calls = [];
  return {calls, connect: async () => ({
    call: async (method, params) => {
      calls.push([method, params]);
      if (method === 'Target.getTargets') return {targetInfos: [
        {type: 'page', targetId: 'unrelated', url: 'https://gemini.google.com/app'},
        {type: 'page', targetId: 'workbench', url: targetUrl},
      ]};
      if (method === 'Browser.getWindowForTarget') return {windowId: 7, bounds: {windowState}};
      return {};
    },
    close: () => calls.push(['close']),
  })};
}
test('a repeated launch restores its minimized workbench without navigation or a new tab', async () => {
  const {calls, connect} = fixture('minimized');
  assert.deepEqual(await showRunnerWorkbench(url, connect), {shown: true, restored: true});
  assert.deepEqual(calls, [
    ['Target.getTargets', undefined],
    ['Browser.getWindowForTarget', {targetId: 'workbench'}],
    ['Browser.setWindowBounds', {windowId: 7, bounds: {windowState: 'normal'}}],
    ['Target.activateTarget', {targetId: 'workbench'}],
    ['close'],
  ]);
});
test('a maximized workbench keeps its window geometry when selected', async () => {
  const {calls, connect} = fixture('maximized');
  assert.deepEqual(await showRunnerWorkbench(url, connect), {shown: true, restored: false});
  assert.equal(calls.some(([method]) => method === 'Browser.setWindowBounds'), false);
  assert.deepEqual(calls.at(-2), ['Target.activateTarget', {targetId: 'workbench'}]);
});
test('a missing workbench never activates a different page and still closes the inspection connection', async () => {
  const {calls, connect} = fixture('normal', url + '/other');
  await assert.rejects(showRunnerWorkbench(url, connect), /not available yet/);
  assert.deepEqual(calls, [['Target.getTargets', undefined], ['close']]);
});

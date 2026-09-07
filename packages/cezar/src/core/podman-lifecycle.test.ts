import { describe, expect, it } from 'vitest';
import { taskContainerName } from './podman-lifecycle.ts';

describe('podman lifecycle', () => {
  it('names a container after its run, prefixed so a stray one is obviously cezar\'s', () => {
    expect(taskContainerName('ab57117a-607c-4393-8bfc-b9c99145dac8')).toBe('cez-ab57117a');
    // Stable for the same run: a Continue must find the container the first
    // turn created, not make a second one beside it.
    expect(taskContainerName('ab57117a-607c-4393-8bfc-b9c99145dac8'))
      .toBe(taskContainerName('ab57117a-607c-4393-8bfc-b9c99145dac8'));
  });
});

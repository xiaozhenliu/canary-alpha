// src/config-cli.ts —— config 子命令的参数解析与输出，不触发重型 bootstrap。
import { ConfigCliService, CliError } from './config/config-cli-service.js';

// 解析 `config <sub> [args...]`，支持 '--' 终止符与 '--reveal'。
export function parseConfigArgs(argv: string[]): {
  sub: string; positionals: string[]; reveal: boolean;
} {
  const after = argv.slice(1); // 去掉 'config'
  const positionals: string[] = [];
  let reveal = false;
  let terminated = false;
  for (let i = 0; i < after.length; i += 1) {
    const v = after[i];
    // '--' 之后的所有 token（含 --reveal）按字面 positional 处理，不再识别为 flag。
    if (!terminated && v === '--') { terminated = true; continue; }
    if (!terminated && v === '--reveal') { reveal = true; continue; }
    positionals.push(v);
  }
  return { sub: positionals[0] ?? '', positionals: positionals.slice(1), reveal };
}

export async function runConfigCommand(argv: string[]): Promise<number> {
  const { sub, positionals, reveal } = parseConfigArgs(argv);
  const svc = new ConfigCliService();
  try {
    switch (sub) {
      case 'path':
        console.log(svc.configPath());
        return 0;
      case 'get': {
        const r = await svc.get(requireArg(positionals, 0, 'path'), { reveal });
        let line = `${r.path} = ${r.display}`;
        if (r.overriddenByEnv) line += `  (overridden by env ${r.overriddenByEnv})`;
        console.log(line);
        if (r.envDegraded) console.error('warning: environment invalid; showing file value only');
        if (reveal) console.error('warning: secret shown in cleartext; mind terminal history/screenshots');
        return 0;
      }
      case 'list': {
        const entries = await svc.list({ reveal });
        for (const e of entries) {
          let line = `${e.path} = ${e.display}`;
          if (e.source === 'default') line += '  (default)';
          if (e.overriddenByEnv) line += `  (overridden by env ${e.overriddenByEnv})`;
          console.log(line);
        }
        if (reveal) console.error('warning: secrets shown in cleartext');
        return 0;
      }
      case 'set': {
        const r = await svc.set(requireArg(positionals, 0, 'path'), requireArg(positionals, 1, 'value'));
        report(r); return 0;
      }
      case 'unset': {
        report(await svc.unset(requireArg(positionals, 0, 'path')));
        return 0;
      }
      case 'add': {
        report(await svc.addToArray(requireArg(positionals, 0, 'path'), requireArg(positionals, 1, 'item')));
        return 0;
      }
      case 'remove': {
        report(await svc.removeFromArray(requireArg(positionals, 0, 'path'), requireArg(positionals, 1, 'item')));
        return 0;
      }
      case 'validate': {
        const r = await svc.validate();
        if (r.ok) { console.log('config valid'); return 0; }
        if (r.syntaxError) console.error(r.syntaxError);
        for (const e of r.errors) console.error(`${e.path}: ${e.message}`);
        return 1;
      }
      default:
        console.error(`Unknown config subcommand: ${sub || '(none)'}`);
        console.error('Usage: config <list|get|set|unset|add|remove|validate|path> ...');
        return 1;
    }
  } catch (e) {
    if (e instanceof CliError) { console.error(e.message); return 1; }
    throw e;
  }
}

function requireArg(arr: string[], i: number, name: string): string {
  const v = arr[i];
  if (v === undefined) throw new CliError(`Missing argument: <${name}>`);
  return v;
}
function report(r: { message: string; overriddenByEnv?: string }): void {
  console.log(r.message);
  if (r.overriddenByEnv) {
    console.error(`warning: ${r.overriddenByEnv} currently overrides this field; unset it for the file value to take effect`);
  }
}

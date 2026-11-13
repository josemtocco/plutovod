// Diagnóstico: mostra o formato real das respostas da Pluto (útil se a API mudar).
//   RESOLVER_BASE_URL=x node src/probe.js
import { readFile } from 'node:fs/promises';
import { PlutoClient } from './pluto.js';

const cfg = JSON.parse(await readFile('config.json', 'utf8'));
const c = new PlutoClient(cfg);
const s = await c.boot();
console.log('País da sessão:', s.country);
const cats = await c.fetchCategories();
console.log('Categorias:', cats.length);
for (const cat of cats.slice(0, 5)) {
  const types = {};
  (cat.items || []).forEach((i) => (types[i.type] = (types[i.type] || 0) + 1));
  console.log(`- ${cat.name}: ${(cat.items || []).length} itens`, types);
}
const first = cats.find((x) => (x.items || []).length)?.items[0];
console.log('Exemplo de item:', JSON.stringify(first, null, 2)?.slice(0, 1500));

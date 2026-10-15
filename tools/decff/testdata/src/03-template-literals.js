// テンプレートリテラルとタグ付きテンプレート
function tag(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      out += '[' + String(values[i]).toUpperCase() + ']';
    }
  });
  return out;
}

const user = 'alexander';
const role = 'researcher';

console.log(tag`user ${user} acts as ${role} today`);
console.log(`plain ${user} / ${role}`);
console.log(`nested ${`inner ${user.length}`} done`);

const multi = `line one
line two
line three`;
console.log(multi.split('\n').length);

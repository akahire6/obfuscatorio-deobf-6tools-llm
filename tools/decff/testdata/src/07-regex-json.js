// 正規表現リテラルと JSON
const text = 'id=42; name=widget; price=9.99; tags=a,b,c';
const pairRe = /(\w+)=([^;]+)/g;

const parsed = {};
let m;
while ((m = pairRe.exec(text)) !== null) {
  parsed[m[1]] = m[2].trim();
}

console.log(JSON.stringify(parsed));

const roundTrip = JSON.parse(JSON.stringify(parsed));
console.log(Object.keys(roundTrip).sort().join(','));

console.log(/^id/.test(text), text.replace(/\s+/g, '_'));
console.log('a1b2c3'.match(/\d/g).join(''));

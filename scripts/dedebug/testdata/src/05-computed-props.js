// 計算プロパティアクセスと動的な文字列連結
const table = {
  alpha: 1,
  beta: 2,
  gamma: 3,
  'with space': 4
};

const keys = ['alpha', 'beta', 'gamma', 'with space', 'missing'];
for (const k of keys) {
  console.log(k + ' -> ' + (table[k] === undefined ? 'none' : table[k]));
}

const prefix = 'al';
const suffix = 'pha';
console.log('dynamic:', table[prefix + suffix]);

const obj = {};
obj['built' + 'Key'] = 'value';
console.log(Object.keys(obj).join(','), obj.builtKey);

console.log(['a', 'b'].map(c => c.charCodeAt(0)).join('-'));

// 利用者コード自身が「5 文字文字列同士の === / !==」で分岐するプログラム。
// deadcode-injection の述語と見分けがつかない形をわざと書いてある。
// 構造ガード（難読化器が作る「1 文だけのブロック」の形かどうか）が
// これを畳まないことを確かめるための負例。

const MODEA = 'alpha';
const MODEB = 'bravo';

function pickByEqual(tag) {
  let label = '';
  // 難読化器の述語と同じ形。ただし前後に文があるのでブロックは 1 文ではない。
  if ('alpha' === 'alpha') {
    label = 'same-branch';
  } else {
    label = 'never';
  }
  if ('alpha' !== 'bravo') {
    label += '/diff-branch';
  } else {
    label += '/never';
  }
  return tag + ':' + label;
}

function pickByVariable(tag) {
  if (MODEA === MODEB) {
    return tag + ':equal';
  } else {
    return tag + ':notequal';
  }
}

console.log(pickByEqual('t1'));
console.log(pickByVariable('t2'));
console.log(pickByEqual('t3') + '|' + pickByVariable('t4'));

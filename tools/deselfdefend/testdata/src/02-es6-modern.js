// const / let / アロー / クラス / デフォルト引数 / 分割代入
class Shape {
  constructor(name, sides = 0) {
    this.name = name;
    this.sides = sides;
  }
  get label() {
    return `${this.name}:${this.sides}`;
  }
  toString() {
    return this.label;
  }
}

class Square extends Shape {
  constructor(size) {
    super('square', 4);
    this.size = size;
  }
  get area() {
    return this.size * this.size;
  }
}

const shapes = [new Shape('point'), new Shape('line', 1), new Square(3)];
const labels = shapes.map(s => s.label);
const { name, sides } = shapes[2];

console.log(labels.join(' | '));
console.log(`picked ${name} with ${sides} sides`);
console.log('area =', shapes[2].area);

const sum = (...xs) => xs.reduce((a, b) => a + b, 0);
console.log('sum =', sum(1, 2, 3, 4, 5));

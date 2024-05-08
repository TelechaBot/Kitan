<script setup lang="ts">
// 制作一个3*3的拼图游戏，8块拼图。有一个打乱按钮，每次打乱时如果此组合不能复原，则重新打乱再检查。当用户成功复原时弹出提示。
// 将此程序制作为组件，传入图片列表参数，切分后分配到拼图蒙版上，打乱会重新选择图像。
import {ref} from 'vue';
// 谜题
const puzzles = ref<number[]>([1, 2, 3, 4, 5, 6, 7, 8, 0]);

const shuffle = () => {
  // 打乱
  puzzles.value.sort(() => Math.random() - 0.5);
  // 检查是否可还原
  while (!check()) {
    puzzles.value.sort(() => Math.random() - 0.5);
  }
};

const check = () => {
  // 检查是否可还原,逆序奇偶性
  let count = 0;
  for (let i = 0; i < 9; i++) {
    if (puzzles.value[i] === 0) {
      count += i / 3 + 1;
    } else {
      for (let j = i + 1; j < 9; j++) {
        if (puzzles.value[j] < puzzles.value[i]) {
          count++;
        }
      }
    }
  }
  return count % 2 != 0;
}

const move = (puzzle: number) => {
  // 如果点击的拼图与0相邻，则交换位置
  const index = puzzles.value.indexOf(puzzle);
  const zeroIndex = puzzles.value.indexOf(0);
  if (index === zeroIndex - 1 || index === zeroIndex + 1 || index === zeroIndex - 3 || index === zeroIndex + 3) {
    puzzles.value[zeroIndex] = puzzle;
    puzzles.value[index] = 0;
  }
  if (puzzles.value.join('') === '123456780') {
    alert('恭喜你，拼图成功！');
  }
};

</script>

<template>
  <div class="box">
    <v-row no-gutters>
      <v-col cols="4" v-for="puzzle in puzzles" :key="puzzle" @click="move(puzzle)">
        <v-card class="puzzle" v-if="puzzle !== 0">{{ puzzle }}</v-card>
      </v-col>
    </v-row>
    <button @click="shuffle">打乱</button>
  </div>
</template>

<style scoped>
.box {
  display: flex;
  flex-wrap: wrap;
  width: 300px;
  height: 300px;
}

.puzzle {
  flex-basis: 33.33%;
  box-sizing: border-box;
  height: 100px;
  line-height: 100px;
  text-align: center;
  border: 1px solid #000;
  font-size: 24px;
}

.fade-enter-active, .fade-leave-active {
  transition: opacity 0.5s;
}

.fade-enter, .fade-leave-to {
  opacity: 0;
}
</style>
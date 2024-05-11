<script setup lang="ts">
import {ref, watch} from 'vue';

const puzzles = ref<number[]>([1, 2, 3, 4, 5, 6, 7, 8, 0]);
const props = defineProps({
  difficultyLevel: {
    type: Number,
    default: 1,
    validator: (value: number) => value >= 1 && value <= 10  // 确保其在合理范围内
  },
  onSuccess: {
    type: Function,
    default: () => {
    },
  },
  imageSrc: {
    type: String,
    default: ''
  }
});


// 当难度等级变化时，自动打乱拼图
watch(() => props.difficultyLevel, () => {
  shuffleUntilSolvable();
});

const move = (index: number, zeroIndex: number) => {
  const temp = puzzles.value[index];
  puzzles.value[index] = puzzles.value[zeroIndex];
  puzzles.value[zeroIndex] = temp;
}

const invCount = (arr: number[]) => {
  let count = 0;
  for (let i = 0; i < 9 - 1; i++)
    for (let j = i + 1; j < 9; j++)
      if (arr[j] && arr[i] && arr[i] > arr[j])
        count++;
  return count;
}

const isSolvable = (puzzle: number[]) => {
  const invCountNum = invCount(puzzle);

  let zeroIndex = puzzle.indexOf(0);
  if (zeroIndex % 2) return !(invCountNum % 2);
  else return invCountNum % 2;
}

const shuffle = () => {
  let zeroIndex = puzzles.value.indexOf(0);
  for (let i = 0; i < (500 * props.difficultyLevel + 500); i++) {
    const direction = Math.floor(Math.random() * 4);
    if (direction === 0 && zeroIndex >= 3) {
      move(zeroIndex, zeroIndex - 3);
      zeroIndex -= 3;
    } else if (direction === 1 && zeroIndex % 3 !== 2) {
      move(zeroIndex, zeroIndex + 1);
      zeroIndex += 1;
    } else if (direction === 2 && zeroIndex <= 5) {
      move(zeroIndex, zeroIndex + 3);
      zeroIndex += 3;
    } else if (direction === 3 && zeroIndex % 3 !== 0) {
      move(zeroIndex, zeroIndex - 1);
      zeroIndex -= 1;
    }
  }
};

const shuffleUntilSolvable = () => {
  shuffle();
  if (!isSolvable(puzzles.value)) {
    shuffleUntilSolvable();
  }
}

shuffleUntilSolvable();

const moveBlock = (puzzle: number) => {
  const index = puzzles.value.indexOf(puzzle);
  const zeroIndex = puzzles.value.indexOf(0);
  if ((index === zeroIndex - 1 && Math.floor(index / 3) === Math.floor(zeroIndex / 3)) ||
      (index === zeroIndex + 1 && Math.floor(index / 3) === Math.floor(zeroIndex / 3)) ||
      index === zeroIndex - 3 || index === zeroIndex + 3) {
    puzzles.value[zeroIndex] = puzzle;
    puzzles.value[index] = 0;
  }
  if (puzzles.value.join('') === '123456780') {
    // 拼图成功，调用 onSuccess 回调
    props.onSuccess();
  }
};
const calculatePosition = (puzzle: number) => {
  puzzle -= 1;  //的到ki正确的宽度和高度索引
  const xIndex = puzzle % 3;
  const yIndex = Math.floor(puzzle / 3);
  return `${-xIndex * 100}px ${-yIndex * 100}px`;
}
</script>

<template>
  <div class="puzzle-container">
    <div class="puzzle-grid">
      <v-row no-gutters>
        <v-col
            cols="4"
            v-for="puzzle in puzzles"
            :key="puzzle"
            @click="moveBlock(puzzle)"
        >
          <v-card
              elevation="0"
              variant="flat"
              v-if="puzzle !== 0"
              class="puzzle-block"
              :style="props.imageSrc ? {backgroundImage: `url(${props.imageSrc})`, backgroundPosition: calculatePosition(puzzle), backgroundSize: '300px 300px' } : {}">
            <span v-if="!props.imageSrc">{{ puzzle }}</span>
          </v-card>
        </v-col>
      </v-row>
    </div>
    <v-btn
        @click="shuffleUntilSolvable"
        block
        variant="outlined"
        color="primary"
    >
      Shuffle
    </v-btn>
  </div>
</template>

<style scoped>
.puzzle-container {
  display: flex;
  margin: 0 auto;
  width: 300px;
  flex-direction: column;
  align-items: center;
  background-color: #f5f5f5;
  border: 1px solid #ddd;
  border-radius: 4px;
  box-shadow: 0 0.5em 1em -0.125em rgba(10, 10, 10, .1), 0 0.25em 0.5em -0.25em rgba(10, 10, 10, .02);
}

.puzzle-grid {
  display: flex;
  width: 300px;
  height: 300px;
  justify-content: center;
  align-items: center;
}

.puzzle-block {
  flex-basis: 33.33%;
  box-sizing: border-box;
  height: 100px;
  line-height: 100px;
  text-align: center;
  border: 1px solid #232323;
  font-size: 24px;
  background-repeat: no-repeat;
  border-radius: 3px;
  transition: all 0.3s ease;
}

.fade-enter-active, .fade-leave-active {
  transition: opacity 0.5s;
}

.fade-enter, .fade-leave-to {
  opacity: 0;
}
</style>
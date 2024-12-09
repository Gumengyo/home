<template>
  <div class="time-capsule">
    <div class="title">
      <hourglass-full theme="two-tone" size="24" :fill="['#efefef', '#00000020']" />
      <span>时光胶囊</span>
    </div>
    <span class="text">今日已经度过了&nbsp;{{ timeData.day.elapsed }}&nbsp;小时</span>
    <el-progress :text-inside="true" :stroke-width="20" :percentage="timeData.day.pass" />
    <span v-if="isWorkday" class="text">还有&nbsp;{{ hoursUntilEndOfWorkday }}&nbsp;小时&nbsp;{{ minutesUntilEndOfWorkday }}&nbsp;分下班</span>
    <el-progress v-if="isWorkday" :text-inside="true" :stroke-width="20" :percentage="timeData.day.pass" />
    <span class="text">本周已经度过了&nbsp;{{ timeData.week.elapsed }}&nbsp;天</span>
    <el-progress :text-inside="true" :stroke-width="20" :percentage="timeData.week.pass" />
    <span class="text">本月已经度过了&nbsp;{{ timeData.month.elapsed }}&nbsp;天</span>
    <el-progress :text-inside="true" :stroke-width="20" :percentage="timeData.month.pass" />
    <span class="text">今年已经度过了&nbsp;{{ timeData.year.elapsed }}&nbsp;个月</span>
    <el-progress :text-inside="true" :stroke-width="20" :percentage="timeData.year.pass" />
    <div v-if="startDate?.length >= 4 && store.siteStartShow">
      <span class="text" v-html="startDateText" />
    </div>
  </div>
</template>

<script setup>
import { HourglassFull } from "@icon-park/vue-next";
import { getTimeCapsule, siteDateStatistics } from "@/utils/getTime.js";
import { mainStore } from "@/store";
const store = mainStore();

// 进度条数据
const timeData = ref(getTimeCapsule());
const startDate = ref(import.meta.env.VITE_SITE_START);
const startDateText = ref(null);
const timeInterval = ref(null);
const hoursUntilEndOfWorkday = ref(null);
const minutesUntilEndOfWorkday = ref(null);
const isWorkday = ref(false);

const workEndTime = import.meta.env.VITE_WORK_END_TIME;

function calculateHoursAndMinutesUntilEndOfWorkday() {
  const now = new Date();
  const [endHour, endMinute] = workEndTime.split(':').map(Number);
  const endOfWorkday = new Date();
  endOfWorkday.setHours(endHour, endMinute, 0, 0);
  const timeDiff = endOfWorkday - now;
  const totalMinutes = Math.floor(timeDiff / (1000 * 60));
  hoursUntilEndOfWorkday.value = Math.floor(totalMinutes / 60);
  minutesUntilEndOfWorkday.value = totalMinutes % 60;
}

function checkWorkday() {
  const now = new Date();
  const day = now.getDay();
  isWorkday.value = day >= 1 && day <= 5; // 周一到周五为工作日
}

onMounted(() => {
  timeInterval.value = setInterval(() => {
    timeData.value = getTimeCapsule();
    if (startDate.value) startDateText.value = siteDateStatistics(new Date(startDate.value));
    calculateHoursAndMinutesUntilEndOfWorkday();
    checkWorkday();
  }, 1000);
});

onBeforeUnmount(() => {
  clearInterval(timeInterval.value);
});
</script>

<style lang="scss" scoped>
.time-capsule {
  width: 100%;
  .title {
    display: flex;
    flex-direction: row;
    align-items: center;
    margin: 0.2rem 0 1.5rem;
    font-size: 1.1rem;
    .i-icon {
      display: flex;
      justify-content: center;
      align-items: center;
      margin-right: 6px;
    }
  }
  .text {
    display: block;
    margin: 1rem 0rem 0.5rem 0rem;
    font-size: 0.95rem;
  }
}
</style>
/**
 * demo-data.js — 演示模式样例数据
 *
 * 结构刻意模拟麦当劳 MCP 工具的真实返回（JSON 对象），
 * 演示模式下会把这份样例喂给与真实模式完全相同的归一化管线（见 app.js），
 * 保证演示卡与真实卡走同一套渲染逻辑。
 *
 * 注意：以下活动 / 优惠券 / 积分 / 抽奖内容均为演示样例，不是实时数据。
 */
(function (global) {
  'use strict';

  function pad(n) { return String(n).padStart(2, '0'); }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function monthEndStr() {
    var d = new Date();
    var end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return end.getFullYear() + '-' + pad(end.getMonth() + 1) + '-' + pad(end.getDate());
  }

  var DEMO_RAW = {
    'now-time-info': {
      date: todayStr(),
      weekDay: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][new Date().getDay()],
      lunar: '演示数据',
      timestamp: Date.now()
    },
    'campaign-calendar': {
      month: todayStr().slice(0, 7),
      campaigns: [
        {
          name: '麦麦省会员日',
          status: 'ongoing',
          description: '指定人气套餐会员专享价，每周三开启',
          startDate: todayStr(),
          endDate: todayStr()
        },
        {
          name: '早餐月卡特惠周',
          status: 'ongoing',
          description: '早餐月卡限时折扣，工作日早餐不纠结',
          startDate: todayStr(),
          endDate: monthEndStr()
        },
        {
          name: '新品尝鲜季',
          status: 'upcoming',
          description: '新品上市，敬请期待',
          startDate: monthEndStr(),
          endDate: monthEndStr()
        }
      ]
    },
    'available-coupons': {
      total: 3,
      coupons: [
        { name: '满30减8元券', description: '全场通用 · 到店/外送均可', source: '麦麦省' },
        { name: '中薯条买一送一券', description: '到店出示使用', source: '麦麦省' },
        { name: '麦旋风第二份半价券', description: '甜品站同享', source: '麦麦省' }
      ]
    },
    'query-my-account': {
      availablePoints: 1280,
      totalPoints: 8650,
      frozenPoints: 0,
      expiringPoints: 120,
      expireDate: monthEndStr()
    },
    'query-lottery-info': {
      name: '积分幸运大转盘',
      status: 'ongoing',
      costPoints: 50,
      prizes: ['巨无霸兑换券', '免费中薯条', '100 积分', '麦乐鸡兑换券'],
      description: '每日可参与，奖品实时发放至券包'
    }
  };

  global.MCD_DEMO_RAW = DEMO_RAW;
})(window);

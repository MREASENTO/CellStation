'use strict';
window.startupProgress=state=>{document.querySelector('#startup-stage').textContent=state.message;document.querySelector('#startup-progress').value=state.percent;document.querySelector('#startup-percent').textContent=state.percent+'%';if(state.detail)document.querySelector('#startup-detail').textContent=state.detail;};

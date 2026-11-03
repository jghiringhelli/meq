const { chromium } = require('@playwright/test');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:390,height:800}});
await p.goto('http://localhost:5199/');await p.setInputFiles('input[accept=".vmod,.zip"]','Middle_Earth_Quest_1.6.vmod');await p.waitForTimeout(4000);
p.on('dialog',d=>d.accept());await p.getByRole('button',{name:'New game'}).click();await p.getByRole('button',{name:'Begin quest'}).click();await p.waitForTimeout(3000);
await p.screenshot({path:'test-results/mobile.png'});await b.close();})();

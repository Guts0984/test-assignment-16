// The adversarial suite in a fixed order on one real stack: the final spec checks the ledger of
// everything the earlier ones did (acceptance #13), so it must run last.
import './stop-stack';
import './acceptance-stock.adv.spec';
import './acceptance-floor.adv.spec';
import './acceptance-jobs.adv.spec';
import './acceptance-security.adv.spec';
import './auth-keys.adv.spec';
import './input-transport.adv.spec';
import './rate-limit.adv.spec';
import './zz-final-ledger.adv.spec';

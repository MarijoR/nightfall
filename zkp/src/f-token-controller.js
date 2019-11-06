/**
This acts as a layer of logic between the index.js, which lands the
rest api calls, and the heavy-lifitng coin-zkp.js and zokrates.js.  It exists so
that the amount of logic in restapi.js is absolutely minimised. It is used for paying
arbitrary amounts of currency in zero knowlege.
@module f-token-controller.js
@author westlad, Chaitanya-Konda, iAmMichaelConnor
*/

import config from 'config';
import jsonfile from 'jsonfile';
import { web3, FTokenShield, VerifierRegistry, Verifier, FToken } from './contract-abstractions';
import { computeProof } from './common-token-functions';
import zkp from './f-token-zkp';
import { computeVectors, computePath, checkRoot } from './compute-vectors';
import Element from './Element';

const utils = require('zkp-utils');

const shield = {}; // this field holds the current Shield contract instance.

async function unlockAccount(address, password) {
  await web3.eth.personal.unlockAccount(address, password, 0);
}

/**
This function allocates a specific FTokenShield contract to a particular user
(or, more accurately, a particular Ethereum address)
@param {string} shieldAddress - the address of the shield contract you want to point to
@param {string} address - the Ethereum address of the user to whom this shieldAddress will apply
*/
async function setShield(shieldAddress, address) {
  if (shieldAddress === undefined) shield[address] = await FTokenShield.deployed();
  else shield[address] = await FTokenShield.at(shieldAddress);
}

function unSetShield(address) {
  delete shield[address];
}

/**
return the address of the shield contract
*/
async function getShieldAddress(account) {
  const fTokenShield = shield[account] ? shield[account] : await FTokenShield.deployed();
  return fTokenShield.address;
}

/**
return the balance of an account
@param {string} address - the address of the Ethereum account
*/
async function getBalance(address) {
  const fTokenShield = shield[address] ? shield[address] : await FTokenShield.deployed();
  const fToken = await FToken.at(await fTokenShield.getFToken.call());
  return fToken.balanceOf.call(address);
}

/**
return the address of the ERC-20 token
*/
async function getFTAddress(address) {
  const fTokenShield = shield[address] ? shield[address] : await FTokenShield.deployed();
  return fTokenShield.getFToken.call();
}

/**
create ERC-20 in an account.  This allows one to mint more coins into the ERC-20
contract that the shield contract is using.  Obviously the ERC-20 needs to support
this functionality and most won't (as it would make the token value zero) but it's
useful to be able to create coins for demonstration purposes.
@param {string} amount - the amount of cryptocurrency to mint
@param {string} address - the address of the Ethereum account
*/
async function buyFToken(amount, address) {
  console.log('Buying ERC-20', amount, address);
  const fTokenShield = shield[address] ? shield[address] : await FTokenShield.deployed();
  const fToken = await FToken.at(await fTokenShield.getFToken.call());
  return fToken.mint(address, amount, {
    from: address,
    gas: 4000000,
  });
}

/**
transfer ERC-20 to an account.  This allows one to transfer a token from fromAddress
to toAddress.  The tranaction fee will be taken from fromAddress
@param {string} amount - the amount of cryptocurrency to transfer
@param {string} toAddress - the address of the Ethereum account to transfer to
@param {string} fromAddress - the address of the Ethereum account to transfer from
*/
async function transferFToken(amount, fromAddress, toAddress) {
  console.log('Transferring ERC-20', amount, toAddress);
  const fTokenShield = shield[fromAddress] ? shield[fromAddress] : await FTokenShield.deployed();
  const fToken = await FToken.at(await fTokenShield.getFToken.call());
  return fToken.transfer(toAddress, amount, {
    from: fromAddress,
    gas: 4000000,
  });
}

/**
Burn a ERC-20 token in an account.  This allows one to delete coins from the ERC-20
contract that the shield contract is using.  Obviously the ERC-20 needs to support
this functionality and most won't (as it would simply destroy value) but it's
useful to be able to delete coins for demonstration purposes.
Note: this is different functionality from 'burning' a commitment (private token).
Burning a commitment recovers the original ERC-20 value.
@param {string} amount - the amount of cryptocurrency to burn
@param {string} address - the address of the Ethereum account
*/
async function burnFToken(amount, address) {
  console.log('Buying ERC-20', amount, address);
  const fTokenShield = shield[address] ? shield[address] : await FTokenShield.deployed();
  const fToken = await FToken.at(await fTokenShield.getFToken.call());
  return fToken.burn(address, amount, {
    from: address,
    gas: 4000000,
  });
}

/**
Return the meta data for the ERC-20 token that the user with the given address
is utilising.
@param address - the address of the user (different users may us different ERC-20 contracts)
@returns - an object containing the token symbol and name.
*/
async function getTokenInfo(address) {
  console.log('Getting ERC-20 info');
  const fTokenShield = shield[address] ? shield[address] : await FTokenShield.deployed();
  const fToken = await FToken.at(await fTokenShield.getFToken.call());
  const symbol = await fToken.symbol.call();
  const name = await fToken.name.call();
  return { symbol, name };
}

/**
Mint a coin
@param {string} S_A - Alice's token serial number as a hex string
@param {string} pkA - Alice's public key
@param {string} A - the value of the coin
@param {string} account - the account from which the payment for the coin will be made
@returns {string} zA - The token
This is a convenience because the sender (Alice)
knows S_A,pkA,n and n so could in fact calculate the token themselves.
@returns {Integer} zAIndex - the index of the token within the Merkle Tree.
This is required for later transfers/joins so that Alice knows which 'chunks' of the Merkle Tree
she needs to 'get' from the fTokenShield contract in order to calculate a path.
*/
async function mint(A, _pkA, _S_A, account) {
  console.group('\nIN MINT...');

  // zero the most significant bits, just in case variables weren't supplied like that
  const pkA = utils.zeroMSBs(_pkA);
  const S_A = utils.zeroMSBs(_S_A);

  console.log('Finding the relevant Shield and Verifier contracts');
  const fTokenShield = shield[account] ? shield[account] : await FTokenShield.deployed();
  const verifier = await Verifier.deployed();
  const verifierRegistry = await VerifierRegistry.deployed();
  console.log('FTokenShield contract address:', fTokenShield.address);
  console.log('Verifier contract address:', verifier.address);
  console.log('VerifierRegistry contract address:', verifierRegistry.address);

  // get the Mint vkId
  console.log('Reading vkIds from json file...');
  const vkIds = await new Promise((resolve, reject) =>
    jsonfile.readFile(config.VK_IDS, (err, data) => {
      // doesn't natively support promises
      if (err) reject(err);
      else resolve(data);
    }),
  );
  const { vkId } = vkIds.MintCoin;
  console.log('Id for MintCoin was', vkId);

  // Calculate new arguments for the proof:
  const zA = utils.zeroMSBs(utils.concatenateThenHash(A, pkA, S_A));

  console.group('Existing Proof Variables:');
  const p = config.ZOKRATES_PACKING_SIZE;
  const pt = Math.ceil((config.INPUTS_HASHLENGTH * 8) / config.ZOKRATES_PACKING_SIZE); // packets in bits
  console.log('A: ', `${A} : `, utils.hexToFieldPreserve(A, p, 1));
  console.log('pkA: ', pkA, ' : ', utils.hexToFieldPreserve(pkA, p, pt));
  console.log('S_A: ', S_A, ' : ', utils.hexToFieldPreserve(S_A, p, pt));
  console.groupEnd();

  console.group('New Proof Variables:');
  console.log('zA: ', zA, ' : ', utils.hexToFieldPreserve(zA, p, pt));
  console.groupEnd();

  const publicInputHash = utils.zeroMSBs(utils.concatenateThenHash(A, zA));
  console.log('publicInputHash:', publicInputHash);

  const inputs = computeVectors([new Element(publicInputHash, 'field', 216, 1)]);
  console.log('inputs:');
  console.log(inputs);

  // get the pwd so we can talk to the container:
  const pwd = process.env.PWD.toString();
  console.log(pwd);

  const hostDir = config.FT_MINT_DIR;
  console.log(hostDir);

  // compute the proof
  console.group('Computing proof with w=[pkA,S_A] x=[A,Z,1]');
  let proof = await computeProof(
    [
      new Element(publicInputHash, 'field', 216, 1),
      new Element(A, 'field', 128, 1),
      new Element(pkA, 'field'),
      new Element(S_A, 'field'),
      new Element(zA, 'field'),
    ],
    hostDir,
  );

  proof = Object.values(proof);
  // convert to flattened array:
  proof = utils.flattenDeep(proof);
  // convert to decimal, as the solidity functions expect uints
  proof = proof.map(el => utils.hexToDec(el));
  console.groupEnd();

  // next, we have to approve withdrawal of sufficient ERC-20 from the minter's
  // account to pay for the minted coin
  console.log('Approving ERC-20 spend from: ', fTokenShield.address);
  const fToken = await FToken.at(await fTokenShield.getFToken.call());
  await fToken.approve(fTokenShield.address, parseInt(A, 16), {
    from: account,
    gas: 4000000,
    gasPrice: config.GASPRICE,
  });
  console.log('ERC-20 spend approved!', parseInt(A, 16));
  console.log('Balance of account', account, (await getBalance(account)).toNumber());

  // with the pre-compute done, and the funds approved, we can mint the token,
  // which is now a reasonably light-weight calculation
  const zAIndex = await zkp.mint(proof, inputs, vkId, A, zA, account, fTokenShield);

  console.log('Mint output: [zA, zAIndex]:', zA, zAIndex.toString());
  console.log('MINT COMPLETE\n');
  console.groupEnd();
  return [zA, zAIndex];
}

/**
This function actually transfers a coin.
@param {string} C - The value of coin C
@param {string} D - The value of coin D
@param {string} E - The value of coin E
@param {string} F - The value of coin F
@param {string} pkB - Bob's public key
@param {string} S_C - Alice's z-coin's serial number as a hex string
@param {string} S_D - Alice's z-coin's serial number as a hex string
@param {string} S_E - Bob's z-coin's serial number as a hex string
@param {string} S_F - Bob's z-coin's serial number as a hex string
@param {string} skA - Alice's private ('s'ecret) key
@param {string} zC - Alice's z-coin (commitment)
@param {integer} zCIndex - the position of zC in the on-chain Merkle Tree
@param {string} zD - Alice's z-coin (commitment)
@param {integer} zDIndex - the position of zD in the on-chain Merkle Tree
@param {string} account - the account that is paying for this
@returns {string} zE - The token
@returns {Integer} z_E_index - the index of the token within the Merkle Tree.  This is required for later transfers/joins so that Alice knows which 'chunks' of the Merkle Tree she needs to 'get' from the fTokenShield contract in order to calculate a path.
@returns {string} zF - The token
@returns {Integer} z_F_index - the index of the token within the Merkle Tree.  This is required for later transfers/joins so that Alice knows which 'chunks' of the Merkle Tree she needs to 'get' from the fTokenShield contract in order to calculate a path.
@returns {object} txObj - a promise of a blockchain transaction
*/
async function transfer(
  C,
  D,
  E,
  F,
  _pkB,
  _S_C,
  _S_D,
  _S_E,
  _S_F,
  _skA,
  _zC,
  zCIndex,
  _zD,
  zDIndex,
  account,
) {
  console.group('\nIN TRANSFER...');

  if (typeof _pkB === 'object') throw new Error('You need to call a batch-transfer');

  // zero the most significant bits, just in case variables weren't supplied like that
  const pkB = utils.zeroMSBs(_pkB);
  const S_C = utils.zeroMSBs(_S_C);
  const S_D = utils.zeroMSBs(_S_D);
  const S_E = utils.zeroMSBs(_S_E);
  const S_F = utils.zeroMSBs(_S_F);
  const skA = utils.zeroMSBs(_skA);
  const zC = utils.zeroMSBs(_zC);
  const zD = utils.zeroMSBs(_zD);

  // due to limitations in the size of the adder implemented in the proof dsl,
  // we need C+D and E+F to easily fit in <128 bits (16 bytes). They could of course
  // be bigger than we allow here.
  const c = parseInt(C, 16) + parseInt(D, 16);
  const e = parseInt(E, 16) + parseInt(F, 16);
  if (c > 0xffffffff || e > 0xffffffff) throw new Error('Coin values are too large');

  console.log('Finding the relevant Shield and Verifier contracts');
  const fTokenShield = shield[account] ? shield[account] : await FTokenShield.deployed();
  const verifier = await Verifier.deployed();
  const verifierRegistry = await VerifierRegistry.deployed();
  console.log('FTokenShield contract address:', fTokenShield.address);
  console.log('Verifier contract address:', verifier.address);
  console.log('VerifierRegistry contract address:', verifierRegistry.address);

  // get the Transfer vkId
  console.log('Reading vkIds from json file...');
  const vkIds = await new Promise((resolve, reject) =>
    jsonfile.readFile(config.VK_IDS, (err, data) => {
      // doesn't natively support promises
      if (err) reject(err);
      else resolve(data);
    }),
  );
  const { vkId } = vkIds.TransferCoin;

  const root = await fTokenShield.latestRoot();
  console.log(`Merkle Root: ${root}`);

  // Calculate new arguments for the proof:
  const pkA = utils.zeroMSBs(utils.hash(skA));
  const nC = utils.zeroMSBs(utils.concatenateThenHash(S_C, skA));
  const nD = utils.zeroMSBs(utils.concatenateThenHash(S_D, skA));
  const zE = utils.zeroMSBs(utils.concatenateThenHash(E, pkB, S_E));
  const zF = utils.zeroMSBs(utils.concatenateThenHash(F, pkA, S_F));

  // we need the Merkle path from the token commitment to the root, expressed as Elements
  const pathC = await computePath(account, fTokenShield, zC, zCIndex);
  const pathCElements = {
    elements: pathC.path.map(
      element => new Element(element, 'field', config.MERKLE_HASHLENGTH * 8, 1),
    ), // we truncate to 216 bits - sending the whole 256 bits will overflow the prime field
    positions: new Element(pathC.positions, 'field', 128, 1),
  };
  // console.log(`pathCElements.path:`, pathCElements.elements);
  // console.log(`pathCElements.positions:`, pathCElements.positions);
  const pathD = await computePath(account, fTokenShield, zD, zDIndex);
  const pathDElements = {
    elements: pathD.path.map(
      element => new Element(element, 'field', config.MERKLE_HASHLENGTH * 8, 1),
    ), // we truncate to 216 bits - sending the whole 256 bits will overflow the prime field
    positions: new Element(pathD.positions, 'field', 128, 1),
  };
  // console.log(`pathDlements.path:`, pathDElements.elements);
  // console.log(`pathDlements.positions:`, pathDElements.positions);

  // Although we only strictly need the root to be reconciled within zokrates, it's easier to check and intercept any errors in js; so we'll first try to reconcole here:
  checkRoot(zC, pathC, root);
  checkRoot(zD, pathD, root);

  console.group('Existing Proof Variables:');
  const p = config.ZOKRATES_PACKING_SIZE;
  console.log(`C: ${C} : ${utils.hexToFieldPreserve(C, p)}`);
  console.log(`D: ${D} : ${utils.hexToFieldPreserve(D, p)}`);
  console.log(`E: ${E} : ${utils.hexToFieldPreserve(E, p)}`);
  console.log(`F: ${F} : ${utils.hexToFieldPreserve(F, p)}`);
  console.log(`pkB: ${pkB} : ${utils.hexToFieldPreserve(pkB, p)}`);
  console.log(`S_C: ${S_C} : ${utils.hexToFieldPreserve(S_C, p)}`);
  console.log(`S_D: ${S_D} : ${utils.hexToFieldPreserve(S_D, p)}`);
  console.log(`S_E: ${S_E} : ${utils.hexToFieldPreserve(S_E, p)}`);
  console.log(`S_F: ${S_F} : ${utils.hexToFieldPreserve(S_F, p)}`);
  console.log(`skA: ${skA} : ${utils.hexToFieldPreserve(skA, p)}`);
  console.log(`zC: ${zC} : ${utils.hexToFieldPreserve(zC, p)}`);
  console.log(`zD: ${zD} : ${utils.hexToFieldPreserve(zD, p)}`);
  console.groupEnd();

  console.group('New Proof Variables:');
  console.log(`pkA: ${pkA} : ${utils.hexToFieldPreserve(pkA, p)}`);
  console.log(`nC: ${nC} : ${utils.hexToFieldPreserve(nC, p)}`);
  console.log(`nD: ${nD} : ${utils.hexToFieldPreserve(nD, p)}`);
  console.log(`zE: ${zE} : ${utils.hexToFieldPreserve(zE, p)}`);
  console.log(`zF: ${zF} : ${utils.hexToFieldPreserve(zF, p)}`);
  console.log(`root: ${root} : ${utils.hexToFieldPreserve(root, p)}`);
  console.groupEnd();

  const publicInputHash = utils.zeroMSBs(utils.concatenateThenHash(root, nC, nD, zE, zF));
  console.log('publicInputHash:', publicInputHash);

  const inputs = computeVectors([new Element(publicInputHash, 'field', 216, 1)]);
  console.log('inputs:');
  console.log(inputs);

  // get the pwd so we can talk to the container:
  const pwd = process.env.PWD.toString();
  console.log(pwd);

  const hostDir = config.FT_TRANSFER_DIR;
  console.log(hostDir);

  // compute the proof
  console.log(
    'Computing proof with w=[C,D,E,F,S_C,S_D,S_E,S_F,pathC[], orderC,pathD[], orderD,skA,pkB]  x=[nC,nD,zE,zF,root,1]',
  );
  console.log(
    'vector order: [C,skA,S_C,pathC[0...31],orderC,D,S_D,pathD[0...31], orderD,nC,nD,E,pkB,S_E,zE,F,S_F,zF,root]',
  );
  let proof = await computeProof(
    [
      new Element(publicInputHash, 'field', 216, 1),
      new Element(C, 'field', 128, 1),
      new Element(skA, 'field'),
      new Element(S_C, 'field'),
      ...pathCElements.elements.slice(1),
      pathCElements.positions,
      new Element(D, 'field', 128, 1),
      new Element(S_D, 'field'),
      ...pathDElements.elements.slice(1),
      pathDElements.positions,
      new Element(nC, 'field'),
      new Element(nD, 'field'),
      new Element(E, 'field', 128, 1),
      new Element(pkB, 'field'),
      new Element(S_E, 'field'),
      new Element(zE, 'field'),
      new Element(F, 'field', 128, 1),
      new Element(S_F, 'field'),
      new Element(zF, 'field'),
      new Element(root, 'field'),
    ],
    hostDir,
  );

  proof = Object.values(proof);
  // convert to flattened array:
  proof = utils.flattenDeep(proof);
  // convert to decimal, as the solidity functions expect uints
  proof = proof.map(el => utils.hexToDec(el));
  console.groupEnd();

  // send the token to Bob by transforming the commitment
  const [zEIndex, zFIndex, txObj] = await zkp.transfer(
    proof,
    inputs,
    vkId,
    root,
    nC,
    nD,
    zE,
    zF,
    account,
    fTokenShield,
  );

  console.log('TRANSFER COMPLETE\n');
  console.groupEnd();
  return {
    z_E: zE,
    z_E_index: zEIndex,
    z_F: zF,
    z_F_index: zFIndex,
    txObj,
  };
}

/**
This function burns a commitment, i.e. it recovers ERC-20 into your
account. All values are hex strings.
@param {string} C - the value of the commitment in hex (i.e. the amount you are burning)
@param {string} skA - the secret key of the person doing the burning (in hex)
@param {string} S_C - the random nonce used in the commitment
@param {string} zC - the value of the commitment being burned
@param {string} zCIndex - the index of the commitment in the Merkle Tree
@param {string} account - the that is paying for the transaction
@param {string} payTo - the account that the paid-out ERC-20 should be sent to (defaults to 'account')
*/
async function burn(C, _skA, _S_C, _zC, zCIndex, account, _payTo) {
  // zero the most significant bits, just in case variables weren't supplied like that
  const S_C = utils.zeroMSBs(_S_C);
  const skA = utils.zeroMSBs(_skA);
  const zC = utils.zeroMSBs(_zC);

  let payTo = _payTo;
  if (payTo === undefined) payTo = account; // have the option to pay out to another address
  // before we can burn, we need to deploy a verifying key to mintVerifier (reusing mint for this)
  console.group('\nIN BURN...');

  console.log('Finding the relevant Shield and Verifier contracts');
  const fTokenShield = shield[account] ? shield[account] : await FTokenShield.deployed();
  const verifier = await Verifier.deployed();
  const verifierRegistry = await VerifierRegistry.deployed();
  console.log('FTokenShield contract address:', fTokenShield.address);
  console.log('Verifier contract address:', verifier.address);
  console.log('VerifierRegistry contract address:', verifierRegistry.address);

  // get the Burn vkId
  console.log('Reading vkIds from json file...');
  const vkIds = await new Promise((resolve, reject) =>
    jsonfile.readFile(config.VK_IDS, (err, data) => {
      // doesn't natively support promises
      if (err) reject(err);
      else resolve(data);
    }),
  );
  const { vkId } = vkIds.BurnCoin;

  const root = await fTokenShield.latestRoot(); // solidity getter for the public variable latestRoot
  console.log(`Merkle Root: ${root}`);

  // Calculate new arguments for the proof:
  const Nc = utils.zeroMSBs(utils.concatenateThenHash(S_C, skA));

  // We need the Merkle path from the commitment to the root, expressed as Elements
  const path = await computePath(account, fTokenShield, zC, zCIndex);
  const pathElements = {
    elements: path.path.map(
      element => new Element(element, 'field', config.MERKLE_HASHLENGTH * 8, 1),
    ), // We can fit the 216 bit hash into a single field - more compact
    positions: new Element(path.positions, 'field', 128, 1),
  };
  // console.log(`pathElements.path:`, pathElements.elements);
  // console.log(`pathElements.positions:`, pathElements.positions);

  // Although we only strictly need the root to be reconciled within zokrates, it's easier to check and intercept any errors in js; so we'll first try to reconcole here:
  checkRoot(zC, path, root);

  // Summarise values in the console:
  console.group('Existing Proof Variables:');
  const p = config.ZOKRATES_PACKING_SIZE;
  console.log(`C: ${C} : ${utils.hexToFieldPreserve(C, p)}`);
  console.log(`skA: ${skA} : ${utils.hexToFieldPreserve(skA, p)}`);
  console.log(`S_C: ${S_C} : ${utils.hexToFieldPreserve(S_C, p)}`);
  console.log(`payTo: ${payTo} : ${utils.hexToFieldPreserve(payTo, p)}`);
  const payToLeftPadded = utils.leftPadHex(payTo, config.INPUTS_HASHLENGTH * 2); // left-pad the payToAddress with 0's to fill all 256 bits (64 octets) (so the sha256 function is hashing the same thing as inside the zokrates proof)
  console.log(`payToLeftPadded: ${payToLeftPadded}`);
  console.groupEnd();

  console.group('New Proof Variables:');
  console.log(`Nc: ${Nc} : ${utils.hexToFieldPreserve(Nc, p)}`);
  console.log(`zC: ${zC} : ${utils.hexToFieldPreserve(zC, p)}`);
  console.log(`root: ${root} : ${utils.hexToFieldPreserve(root, p)}`);
  console.groupEnd();

  const publicInputHash = utils.concatenateThenHash(root, Nc, C, payToLeftPadded); // notice we're using the version of payTo which has been padded to 256-bits; to match our derivation of publicInputHash within our zokrates proof.
  console.log('publicInputHash:', publicInputHash);

  const inputs = computeVectors([new Element(publicInputHash, 'field', 216, 1)]);
  console.log('inputs:');
  console.log(inputs);

  // get the pwd so we can talk to the container:
  const pwd = process.env.PWD.toString();
  console.log(pwd);

  const hostDir = config.FT_BURN_DIR;
  console.log(hostDir);

  // compute the proof
  console.group('Computing proof with w=[skA,S_C,path[],order] x=[C,Nc,root,1]');
  let proof = await computeProof(
    [
      new Element(publicInputHash, 'field', 216, 1),
      new Element(payTo, 'field'),
      new Element(C, 'field', 128, 1),
      new Element(skA, 'field'),
      new Element(S_C, 'field'),
      ...pathElements.elements.slice(1),
      pathElements.positions,
      new Element(Nc, 'field'),
      new Element(root, 'field'),
    ],
    hostDir,
  );

  proof = Object.values(proof);
  // convert to flattened array:
  proof = utils.flattenDeep(proof);
  // convert to decimal, as the solidity functions expect uints
  proof = proof.map(el => utils.hexToDec(el));
  console.groupEnd();

  // with the pre-compute done we can burn the token, which is now a reasonably
  // light-weight calculation
  await zkp.burn(proof, inputs, vkId, root, Nc, C, payTo, account, fTokenShield);

  console.log('BURN COMPLETE\n');
  console.groupEnd();
  return { z_C: zC, z_C_index: zCIndex };
}

async function checkCorrectness(C, pk, S, z, zIndex, account) {
  const fTokenShield = shield[account] ? shield[account] : await FTokenShield.deployed();

  const results = await zkp.checkCorrectness(C, pk, S, z, zIndex, fTokenShield);
  console.log('\nf-token-controller', '\ncheckCorrectness', '\nresults', results);

  return results;
}

export default {
  burn,
  transfer,
  mint,
  computeProof,
  getBalance,
  getFTAddress,
  buyFToken,
  transferFToken,
  burnFToken,
  getTokenInfo,
  unlockAccount,
  setShield,
  unSetShield,
  checkCorrectness,
  getShieldAddress,
};

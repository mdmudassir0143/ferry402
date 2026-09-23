// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract EscrowTest is Test {
    Escrow escrow;
    MockUSDC usdc;
    address merchant = address(0xBEEF);
    uint256 payerKey = 0xA11CE;
    address payer;

    function setUp() public {
        payer = vm.addr(payerKey);
        usdc = new MockUSDC();
        escrow = new Escrow(address(usdc));
        usdc.mint(payer, 1_000e6);
    }

    function test_settleAuthorization_creditsMerchant() public {
        Escrow.Authorization memory auth = Escrow.Authorization({
            from: payer,
            to: address(escrow),
            value: 10e6,
            validAfter: 0,
            validBefore: block.timestamp + 3600,
            nonce: bytes32(uint256(1))
        });
        (uint8 v, bytes32 r, bytes32 s) = _sign(auth);

        escrow.settleAuthorization(merchant, auth, v, r, s);

        assertEq(escrow.balanceOf(merchant), 10e6);
        assertEq(usdc.balanceOf(address(escrow)), 10e6);
    }

    function _sign(Escrow.Authorization memory a)
        internal view returns (uint8, bytes32, bytes32)
    {
        bytes32 digest = usdc.receiveAuthorizationDigest(
            a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce
        );
        return vm.sign(payerKey, digest);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Test-only ERC-20. Placed with anvil_setCode at a real token address, so no
/// constructor runs: `setup` sets decimals and whether `transfer` returns a
/// bool (Ethereum USDT does not). `mint` is open: never deploy this anywhere real.
contract TestToken {
    event Transfer(address indexed from, address indexed to, uint256 value);

    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    uint8 public decimals;
    bool public noReturn;

    function setup(uint8 decimals_, bool noReturn_) external {
        decimals = decimals_;
        noReturn = noReturn_;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
        totalSupply += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        if (noReturn) {
            assembly { return(0, 0) }
        }
        return true;
    }
}
